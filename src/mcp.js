// MCP 客户端（零依赖）：支持 stdio 与 Streamable HTTP，配置文件 mcp.json 热更新
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { ROOT } from "./config.js";
import { readSSE } from "./protocol/sse.js";
import { IS_WIN } from "./tools/util.js";

export const MCP_FILE = path.join(ROOT, "mcp.json");
const PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = { name: "ci-agent", version: "0.1.0" };

class StdioTransport {
	constructor(cfg) {
		this.cfg = cfg;
		this.pending = new Map();
		this.seq = 0;
		this.stderr = "";
	}
	async start() {
		const { command, args = [], env = {}, cwd } = this.cfg;
		this.child = spawn(command, args, {
			env: { ...process.env, ...env },
			cwd: cwd || ROOT,
			shell: IS_WIN, // Windows 下 npx/uvx 等是 .cmd，需要 shell
			windowsHide: true,
		});
		let buf = "";
		this.child.stdout.on("data", (d) => {
			buf += d;
			let i;
			while ((i = buf.indexOf("\n")) >= 0) {
				const line = buf.slice(0, i).trim();
				buf = buf.slice(i + 1);
				if (line) this.onMessage(line);
			}
		});
		this.child.stderr.on("data", (d) => (this.stderr = (this.stderr + d).slice(-4000)));
		this.child.on("exit", (code) => {
			const err = new Error(`MCP 进程退出（${code}）：${this.stderr.slice(-500)}`);
			for (const p of this.pending.values()) p.reject(err);
			this.pending.clear();
			this.onClose?.(err);
		});
		await new Promise((res, rej) => {
			this.child.once("spawn", res);
			this.child.once("error", rej);
		});
	}
	onMessage(line) {
		let msg;
		try {
			msg = JSON.parse(line);
		} catch {
			return;
		}
		if (msg.id != null && this.pending.has(msg.id)) {
			const p = this.pending.get(msg.id);
			this.pending.delete(msg.id);
			msg.error ? p.reject(new Error(msg.error.message || JSON.stringify(msg.error))) : p.resolve(msg.result);
		} else if (msg.method === "notifications/tools/list_changed") this.onToolsChanged?.();
	}
	request(method, params, { timeout = 60000, signal } = {}) {
		const id = ++this.seq;
		this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
		return new Promise((resolve, reject) => {
			const t = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`MCP 请求超时：${method}`));
			}, timeout);
			signal?.addEventListener("abort", () => {
				this.pending.delete(id);
				this.notify("notifications/cancelled", { requestId: id });
				reject(new Error("已中止"));
			});
			this.pending.set(id, {
				resolve: (v) => (clearTimeout(t), resolve(v)),
				reject: (e) => (clearTimeout(t), reject(e)),
			});
		});
	}
	notify(method, params) {
		this.child?.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
	}
	close() {
		if (!this.child || this.child.exitCode !== null) return;
		if (IS_WIN) spawnSync("taskkill", ["/PID", String(this.child.pid), "/T", "/F"], { stdio: "ignore" });
		else this.child.kill();
	}
}

class HttpTransport {
	constructor(cfg) {
		this.cfg = cfg;
		this.seq = 0;
		this.sessionId = null;
	}
	async start() {}
	async post(body, signal) {
		const res = await fetch(this.cfg.url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
				"MCP-Protocol-Version": PROTOCOL_VERSION,
				...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}),
				...(this.cfg.headers || {}),
			},
			body: JSON.stringify(body),
			signal,
		});
		const sid = res.headers.get("mcp-session-id");
		if (sid) this.sessionId = sid;
		if (!res.ok && res.status !== 202) throw new Error(`MCP HTTP ${res.status}：${(await res.text()).slice(0, 300)}`);
		return res;
	}
	async request(method, params, { timeout = 60000, signal } = {}) {
		const id = ++this.seq;
		const ctl = new AbortController();
		const t = setTimeout(() => ctl.abort(), timeout);
		signal?.addEventListener("abort", () => ctl.abort());
		try {
			const res = await this.post({ jsonrpc: "2.0", id, method, params }, ctl.signal);
			const type = res.headers.get("content-type") || "";
			if (type.includes("text/event-stream")) {
				for await (const { data } of readSSE(res, ctl.signal)) {
					let msg;
					try {
						msg = JSON.parse(data);
					} catch {
						continue;
					}
					if (msg.id === id) {
						if (msg.error) throw new Error(msg.error.message);
						return msg.result;
					}
				}
				throw new Error("MCP 响应流意外结束");
			}
			const msg = await res.json();
			if (msg.error) throw new Error(msg.error.message);
			return msg.result;
		} finally {
			clearTimeout(t);
		}
	}
	notify(method, params) {
		this.post({ jsonrpc: "2.0", method, params }).catch(() => {});
	}
	close() {
		if (this.sessionId) fetch(this.cfg.url, { method: "DELETE", headers: { "Mcp-Session-Id": this.sessionId } }).catch(() => {});
	}
}

class McpServer {
	constructor(name, cfg, manager) {
		this.name = name;
		this.cfg = cfg;
		this.manager = manager;
		this.status = "stopped"; // stopped | starting | ready | error
		this.error = null;
		this.tools = [];
	}
	async start() {
		this.status = "starting";
		this.manager.changed();
		try {
			this.transport = this.cfg.url ? new HttpTransport(this.cfg) : new StdioTransport(this.cfg);
			this.transport.onClose = (e) => {
				if (this.status === "stopped") return;
				this.status = "error";
				this.error = e.message;
				this.tools = [];
				this.manager.changed();
			};
			this.transport.onToolsChanged = () => this.refreshTools().catch(() => {});
			await this.transport.start();
			await this.transport.request("initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO }, { timeout: 120000 });
			this.transport.notify("notifications/initialized", {});
			await this.refreshTools();
			this.status = "ready";
			this.error = null;
		} catch (e) {
			this.status = "error";
			this.error = e.message;
			this.transport?.close();
		}
		this.manager.changed();
	}
	async refreshTools() {
		const all = [];
		let cursor;
		do {
			const r = await this.transport.request("tools/list", cursor ? { cursor } : {});
			all.push(...(r.tools || []));
			cursor = r.nextCursor;
		} while (cursor);
		this.tools = all.map((t) => this.wrap(t));
		this.manager.changed();
	}
	wrap(t) {
		const server = this;
		return {
			name: `mcp__${this.name}__${t.name}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64),
			shortName: t.name,
			label: `${this.name} · ${t.title || t.name}`,
			server: this.name,
			external: true,
			alwaysLoad: !!this.cfg.alwaysLoad,
			readOnly: !!t.annotations?.readOnlyHint,
			description: (t.description || "").slice(0, 1500),
			parameters: t.inputSchema || { type: "object", properties: {} },
			async run(args, ctx) {
				if (server.status !== "ready") throw new Error(`MCP 服务器 ${server.name} 未就绪：${server.error || server.status}`);
				const r = await server.transport.request("tools/call", { name: t.name, arguments: args }, { timeout: (server.cfg.timeout || 300) * 1000, signal: ctx.signal });
				const parts = (r.content || []).map((c) =>
					c.type === "text" ? c.text : c.type === "resource" ? c.resource?.text || `[资源 ${c.resource?.uri}]` : `[${c.type}]`,
				);
				if (!parts.length && r.structuredContent) parts.push(JSON.stringify(r.structuredContent, null, 2));
				return { content: parts.join("\n") || "（无输出）", isError: !!r.isError };
			},
		};
	}
	stop() {
		this.status = "stopped";
		this.tools = [];
		this.transport?.close();
	}
}

export class McpManager extends EventEmitter {
	constructor() {
		super();
		this.servers = new Map();
		this.config = {};
	}

	readConfig() {
		if (!fs.existsSync(MCP_FILE)) fs.writeFileSync(MCP_FILE, JSON.stringify({ mcpServers: {} }, null, "\t"));
		try {
			return JSON.parse(fs.readFileSync(MCP_FILE, "utf8")).mcpServers || {};
		} catch (e) {
			this.emit("error", new Error(`mcp.json 解析失败：${e.message}`));
			return null;
		}
	}

	/** 按配置差异启动 / 停止 / 重启服务器 */
	sync() {
		const next = this.readConfig();
		if (!next) return;
		for (const [name, srv] of this.servers) {
			const cfg = next[name];
			if (!cfg || cfg.enabled === false || JSON.stringify(cfg) !== JSON.stringify(srv.cfg)) {
				srv.stop();
				this.servers.delete(name);
			}
		}
		for (const [name, cfg] of Object.entries(next)) {
			if (cfg.enabled === false || this.servers.has(name)) continue;
			const srv = new McpServer(name, cfg, this);
			this.servers.set(name, srv);
			srv.start();
		}
		this.config = next;
		this.changed();
	}

	watch() {
		this.sync();
		let timer;
		fs.watch(path.dirname(MCP_FILE), (_, file) => {
			if (file !== path.basename(MCP_FILE)) return;
			clearTimeout(timer);
			timer = setTimeout(() => this.sync(), 300);
		});
	}

	setEnabled(name, enabled) {
		const raw = JSON.parse(fs.readFileSync(MCP_FILE, "utf8"));
		if (!raw.mcpServers?.[name]) throw new Error(`未知 MCP 服务器：${name}`);
		raw.mcpServers[name].enabled = enabled;
		fs.writeFileSync(MCP_FILE, JSON.stringify(raw, null, "\t"));
		this.sync();
	}

	changed() {
		this.emit("change");
	}

	tools() {
		return [...this.servers.values()].flatMap((s) => s.tools);
	}

	status() {
		return Object.entries(this.config).map(([name, cfg]) => {
			const s = this.servers.get(name);
			return {
				name,
				enabled: cfg.enabled !== false,
				transport: cfg.url ? "http" : "stdio",
				target: cfg.url || [cfg.command, ...(cfg.args || [])].join(" "),
				status: s?.status || "stopped",
				error: s?.error || null,
				tools: s?.tools.map((t) => ({ name: t.shortName, description: t.description.slice(0, 200) })) || [],
				alwaysLoad: !!cfg.alwaysLoad,
			};
		});
	}

	stopAll() {
		for (const s of this.servers.values()) s.stop();
	}
}
