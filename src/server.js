#!/usr/bin/env node
// 网页服务：只监听 127.0.0.1，启动时生成访问令牌，校验 Host/Origin 防止跨站与 DNS 重绑定
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { loadConfig, saveConfig, resolveModel, onConfigSaved, ROOT, DATA_DIR } from "./config.js";
import { Agent } from "./agent/agent.js";
import { Session } from "./agent/session.js";
import { ensureProject, projectDir, loadProjectPrompt, projectPromptFile, DEFAULT_PROJECT_PROMPT, loadProjectSettings, saveProjectSettings } from "./agent/context.js";
import { ToolRegistry, BUILTIN_TOOLS } from "./tools/index.js";
import { McpManager, MCP_FILE } from "./mcp.js";
import { SkillManager, SKILLS_DIR } from "./skills.js";
import { THINKING_LEVELS, thinkMap, OFFICIAL_THINK } from "./protocol/index.js";
import { IS_WIN } from "./tools/util.js";

const argv = process.argv.slice(2);
const PORT = Number(argv[argv.indexOf("--port") + 1]) || Number(process.env.CI_PORT) || 8787;
const HOST = "127.0.0.1";
const TOKEN = process.env.CI_TOKEN || crypto.randomBytes(18).toString("base64url");
const WEB_DIR = path.join(ROOT, "web");
const PROJECTS_FILE = path.join(DATA_DIR, "projects.json");
const MASK = "••••••";

let config = loadConfig();
// 配置文件被手动改过就重新读，避免内存里的旧配置写回去覆盖掉
let configMtime = 0;
function syncConfig() {
	try {
		const t = fs.statSync(path.join(DATA_DIR, "config.json")).mtimeMs;
		if (configMtime && t !== configMtime) config = loadConfig();
		configMtime = t;
	} catch {}
}
syncConfig();
const mcp = new McpManager();
const skills = new SkillManager(() => config.settings.disabledSkills || []);
const registry = new ToolRegistry({ external: () => mcp.tools() });

// ───────────── 事件广播（SSE） ─────────────
const clients = new Set();
function broadcast(payload) {
	const data = `data: ${JSON.stringify(payload)}\n\n`;
	for (const res of clients) res.write(data);
}
mcp.on("change", () => broadcast({ kind: "mcp" }));
mcp.on("error", (e) => broadcast({ kind: "notice", text: e.message }));
skills.on("change", () => broadcast({ kind: "skills" }));

// ───────────── 项目与会话 ─────────────
function readProjects() {
	try {
		return JSON.parse(fs.readFileSync(PROJECTS_FILE, "utf8"));
	} catch {
		return [];
	}
}
const samePath = (a, b) => (IS_WIN ? a.toLowerCase() === b.toLowerCase() : a === b);
function writeProjects(list) {
	fs.mkdirSync(DATA_DIR, { recursive: true });
	fs.writeFileSync(PROJECTS_FILE, JSON.stringify(list, null, "\t"));
}
function touchProject(cwd) {
	const list = readProjects();
	const old = list.find((p) => samePath(p.path, cwd));
	if (old) old.lastUsed = Date.now();
	else list.push({ path: cwd, lastUsed: Date.now() }); // 新项目排在末尾，侧栏顺序保持稳定
	writeProjects(list);
}

// 进行中的会话。键带上项目路径，不同项目的会话互不干扰，可同时运行
const live = new Map(); // key(cwd, id) → { agent, session, cwd }
const key = (cwd, id) => `${IS_WIN ? cwd.toLowerCase() : cwd}|${id}`;

function checkCwd(cwd) {
	if (!cwd || !path.isAbsolute(cwd)) throw httpErr(400, "需要项目目录的绝对路径");
	if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw httpErr(400, `目录不存在：${cwd}`);
	return path.resolve(cwd);
}

function makeAgent(cwd, session, modelId, messages = [], thinking, statsFrom = 0) {
	const sid = session.id;
	return new Agent({
		thinking,
		model: resolveModel(config, modelId),
		cwd,
		registry,
		settings: config.settings,
		session,
		messages,
		statsFrom,
		getSkills: () => skills.enabled(cwd),
		onEvent: (ev) => broadcast({ kind: "agent", cwd, sessionId: sid, ev }),
	});
}

function getLive(cwd, id) {
	if (live.has(key(cwd, id))) return live.get(key(cwd, id));
	const session = new Session(cwd, id);
	if (!fs.existsSync(session.file)) throw httpErr(404, "会话不存在");
	const { messages, meta, statsFrom } = session.load();
	let modelId = meta.model;
	if (!config.models[modelId]) modelId = config.defaultModel;
	const entry = { agent: makeAgent(cwd, session, modelId, messages, meta.thinking, statsFrom), session, cwd };
	live.set(key(cwd, id), entry);
	return entry;
}

function sessionList(cwd) {
	return Session.list(cwd).map((s) => ({ ...s, running: !!live.get(key(cwd, s.id))?.agent.running }));
}
/** 侧栏数据：所有项目及其会话 */
function projectTree() {
	return readProjects().map((p) => {
		const exists = fs.existsSync(p.path);
		return { path: p.path, name: path.basename(p.path) || p.path, exists, lastUsed: p.lastUsed, sessions: exists ? sessionList(p.path) : [] };
	});
}

function sessionView({ agent, session }) {
	return {
		id: session.id,
		model: agent.model.id,
		running: agent.running,
		thinking: agent.thinking,
		messages: agent.messages,
		contextTokens: agent.contextTokens(),
		contextWindow: agent.model.contextWindow,
		compactAt: agent.model.compactAt,
	};
}

// ───────────── 配置（API Key 打码返回） ─────────────
function maskedConfig() {
	const c = structuredClone(config);
	for (const p of Object.values(c.providers)) if (p.apiKey) p.apiKey = MASK + p.apiKey.slice(-4);
	return c;
}
function applyConfig(next) {
	for (const [id, p] of Object.entries(next.providers || {})) {
		if (typeof p.apiKey === "string" && p.apiKey.startsWith(MASK)) p.apiKey = config.providers[id]?.apiKey ?? "";
		if (!["openai", "anthropic", "gemini"].includes(p.protocol)) throw httpErr(400, `供应商 ${id} 的协议必须是 openai、anthropic 或 gemini`);
	}
	for (const [id, m] of Object.entries(next.models || {})) {
		if (!next.providers[m.provider]) throw httpErr(400, `模型 ${id} 引用了不存在的供应商 ${m.provider}`);
	}
	if (!next.models[next.defaultModel]) next.defaultModel = Object.keys(next.models)[0];
	config = { ...config, ...next, settings: { ...config.settings, ...(next.settings || {}) } };
	saveConfig(config);
	// 已打开的会话更新模型参数（如上下文长度）
	for (const { agent } of live.values()) {
		try {
			agent.model = resolveModel(config, config.models[agent.model.id] ? agent.model.id : config.defaultModel);
			agent.settings = config.settings;
		} catch {}
	}
}

// ───────────── HTTP 工具函数 ─────────────
function httpErr(status, message) {
	return Object.assign(new Error(message), { status });
}
function send(res, status, body) {
	res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
	res.end(JSON.stringify(body));
}
async function readBody(req) {
	let size = 0;
	const chunks = [];
	for await (const c of req) {
		size += c.length;
		if (size > 20 * 1024 * 1024) throw httpErr(413, "请求体过大");
		chunks.push(c);
	}
	if (!chunks.length) return {};
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw httpErr(400, "请求体不是合法 JSON");
	}
}

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2" };
function serveStatic(req, res, pathname) {
	const file = path.join(WEB_DIR, pathname === "/" ? "index.html" : pathname);
	if (!file.startsWith(WEB_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, { error: "未找到" });
	res.writeHead(200, {
		"Content-Type": (MIME[path.extname(file)] || "application/octet-stream") + "; charset=utf-8",
		"Cache-Control": "no-cache",
		"Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
		"X-Content-Type-Options": "nosniff",
		"X-Frame-Options": "DENY",
	});
	fs.createReadStream(file).pipe(res);
}

function allowedHost(h) {
	return h === `${HOST}:${PORT}` || h === `localhost:${PORT}`;
}

// ───────────── 路由 ─────────────
async function api(req, res, url) {
	const p = url.pathname;
	const q = Object.fromEntries(url.searchParams);
	const m = req.method;
	let r;

	if (p === "/api/events" && m === "GET") {
		res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
		res.write(": connected\n\n");
		clients.add(res);
		const ping = setInterval(() => res.write(": ping\n\n"), 20000);
		req.on("close", () => {
			clearInterval(ping);
			clients.delete(res);
		});
		return;
	}

	if (p === "/api/state" && m === "GET") {
		const cwd = q.cwd && fs.existsSync(q.cwd) ? q.cwd : null;
		return send(res, 200, {
			models: Object.entries(config.models).map(([id, mm]) => ({
				id,
				name: mm.name || id,
				protocol: config.providers[mm.provider]?.protocol,
				contextWindow: mm.contextWindow,
				toolStyle: mm.toolStyle || "native",
				// 实际生效的档位映射（设置界面显示“档位 → 请求参数”的翻译）
				thinkMap: (() => {
					try {
						return thinkMap({ ...mm, provider: config.providers[mm.provider] });
					} catch {
						return { off: {} };
					}
				})(),
			})).map((x) => ({ ...x, thinkLevels: THINKING_LEVELS.filter((l) => l in x.thinkMap) })),
			thinkOfficial: OFFICIAL_THINK,
			defaultModel: config.defaultModel,
			projects: readProjects(),
			skills: skills.all(cwd),
			mcp: mcp.status(),
			tools: BUILTIN_TOOLS.map((t) => ({ name: t.name, label: t.label, claude: t.claude?.name })),
		});
	}

	if (p === "/api/config") {
		if (m === "GET") return send(res, 200, maskedConfig());
		if (m === "PUT") {
			applyConfig(await readBody(req));
			broadcast({ kind: "config" });
			return send(res, 200, maskedConfig());
		}
	}

	if (p === "/api/fs/dirs" && m === "GET") {
		// 目录浏览（选择项目用）
		let dir = q.path;
		if (!dir) {
			if (IS_WIN) {
				const drives = [];
				for (const l of "CDEFGHIJKLMNOPQRSTUVWXYZ") if (fs.existsSync(`${l}:\\`)) drives.push({ name: `${l}:`, path: `${l}:\\` });
				return send(res, 200, { path: "", parent: null, dirs: drives });
			}
			dir = "/";
		}
		dir = path.resolve(dir);
		const dirs = fs
			.readdirSync(dir, { withFileTypes: true })
			.filter((e) => e.isDirectory() && !e.name.startsWith("$"))
			.map((e) => ({ name: e.name, path: path.join(dir, e.name) }))
			.sort((a, b) => a.name.localeCompare(b.name));
		const parent = path.dirname(dir) === dir ? (IS_WIN ? "" : null) : path.dirname(dir);
		return send(res, 200, { path: dir, parent, dirs });
	}

	if (p === "/api/projects") {
		if (m === "GET") return send(res, 200, projectTree());
		if (m === "POST") {
			const b = await readBody(req);
			if (b.create) {
				// 新建项目目录：父目录必须已存在，名字不能带路径分隔符
				const parent = checkCwd(b.parent);
				const name = String(b.name || "").trim();
				if (!name || /[\/:*?"<>|]/.test(name) || name === "." || name === "..") throw httpErr(400, "文件夹名不合法");
				const dir = path.join(parent, name);
				if (fs.existsSync(dir)) throw httpErr(409, `已存在：${dir}`);
				fs.mkdirSync(dir);
				b.path = dir;
			}
			const cwd = checkCwd(b.path);
			ensureProject(cwd);
			touchProject(cwd);
			return send(res, 200, { path: cwd });
		}
		if (m === "DELETE") {
			// 从列表移除，并删除该项目的 .ci（会话记录、项目记忆）。项目本身的文件不动
			const cwd = path.resolve(String(q.cwd || ""));
			if (!readProjects().some((x) => samePath(x.path, cwd))) throw httpErr(404, "项目不在列表中");
			for (const [k, e] of live) if (samePath(e.cwd, cwd)) (e.agent.abort(), live.delete(k));
			const dir = projectDir(cwd);
			if (path.basename(dir) === ".ci" && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
			writeProjects(readProjects().filter((x) => !samePath(x.path, cwd)));
			return send(res, 200, { ok: true });
		}
	}

	if (p === "/api/sessions") {
		if (m === "GET") {
			const cwd = checkCwd(q.cwd);
			return send(res, 200, sessionList(cwd));
		}
		if (m === "POST") {
			const b = await readBody(req);
			const cwd = checkCwd(b.cwd);
			touchProject(cwd);
			const session = new Session(cwd);
			const modelId = config.models[b.model] ? b.model : config.defaultModel;
			const thinking = THINKING_LEVELS.includes(b.thinking) ? b.thinking : "off";
			session.append({ type: "meta", meta: { model: modelId, cwd, thinking } });
			const entry = { agent: makeAgent(cwd, session, modelId, [], thinking), session, cwd };
			live.set(key(cwd, session.id), entry);
			return send(res, 200, sessionView(entry));
		}
	}

	if ((r = /^\/api\/sessions\/([\w-]+)(?:\/(\w+))?$/.exec(p))) {
		const [, id, action] = r;
		const cwd = checkCwd(q.cwd);
		const entry = getLive(cwd, id);
		const { agent, session } = entry;

		if (!action && m === "GET") return send(res, 200, sessionView(entry));
		if (!action && m === "DELETE") {
			if (agent.running) agent.abort();
			live.delete(key(cwd, id));
			fs.rmSync(session.file, { force: true });
			return send(res, 200, { ok: true });
		}
		if (action === "prompt" && m === "POST") {
			const b = await readBody(req);
			const content = b.images?.length
				? [...b.images.map((im) => ({ type: "image", mime: im.mime, data: im.data })), { type: "text", text: b.text || "" }]
				: b.text || null;
			// 空白提交：不追加用户消息，直接把现有上下文发给模型（断联后继续）
			if (!content && agent.running) throw httpErr(409, "运行中不能空白提交");
			if (!agent.running) {
				// 同一项目同一时间只允许一个会话运行（避免多个代理同时改同一批文件）
				for (const e of live.values()) if (e !== entry && e.agent.running && samePath(e.cwd, cwd)) throw httpErr(409, "这个项目里已有会话在运行，等它结束或先停止它");
			}
			if (agent.running) {
				agent.steer(b.text);
				return send(res, 200, { queued: true });
			}
			agent
				.run(content)
				.then((text) => broadcast({ kind: "agent", cwd, sessionId: id, ev: { type: "done", text } }))
				.catch((e) =>
					broadcast({ kind: "agent", cwd, sessionId: id, ev: { type: e.name === "AbortError" ? "aborted" : "error", message: e.message } }),
				)
				.finally(() => broadcast({ kind: "agent", cwd, sessionId: id, ev: { type: "idle", contextTokens: agent.contextTokens() } }));
			broadcast({ kind: "agent", cwd, sessionId: id, ev: { type: "busy" } });
			return send(res, 200, { started: true });
		}
		if (action === "deleteturn" && m === "POST") {
			if (agent.running) throw httpErr(409, "运行中不能删除对话");
			const n = Number((await readBody(req)).turn);
			if (!Number.isInteger(n) || n < 0) throw httpErr(400, "turn 必须是非负整数");
			if (!agent.deleteTurn(n)) throw httpErr(404, "找不到这轮对话");
			return send(res, 200, sessionView(entry));
		}
		if (action === "stoptool" && m === "POST") {
			const { callId } = await readBody(req);
			return send(res, 200, { ok: agent.stopTool(String(callId)) });
		}
		if (action === "abort" && m === "POST") {
			agent.abort();
			return send(res, 200, { ok: true });
		}
		if (action === "compact" && m === "POST") {
			if (agent.running) throw httpErr(409, "运行中不能手动压缩，可等待自动压缩");
			const ok = await agent.compact((await readBody(req)).focus || "", "manual");
			return send(res, 200, { ok, ...sessionView(entry) });
		}
		if (action === "model" && m === "PUT") {
			const { model } = await readBody(req);
			agent.model = resolveModel(config, model);
			agent.semaphore.n = agent.model.maxParallel;
			agent.lastPromptTokens = 0;
			agent.countedUpTo = 0;
			session.append({ type: "meta", meta: { model } });
			return send(res, 200, sessionView(entry));
		}
		if (action === "thinking" && m === "PUT") {
			const { thinking } = await readBody(req);
			if (!THINKING_LEVELS.includes(thinking)) throw httpErr(400, `思考强度只能是 ${THINKING_LEVELS.join(" / ")}`);
			agent.thinking = thinking; // 运行中修改，下一轮生效
			session.append({ type: "meta", meta: { thinking } });
			return send(res, 200, { ok: true });
		}
		if (action === "title" && m === "PUT") {
			session.append({ type: "meta", meta: { title: String((await readBody(req)).title || "").slice(0, 100) } });
			return send(res, 200, { ok: true });
		}
	}

	if (p === "/api/skills" && m === "POST") {
		// 新建技能：全局 skills/<名>/SKILL.md，或项目 .ci/skills/<名>/SKILL.md
		const b = await readBody(req);
		const name = String(b.name || "").trim();
		if (!/^[\w\u4e00-\u9fff-]{1,60}$/.test(name)) throw httpErr(400, "技能名只能用字母、数字、中文、- 和 _");
		const base = b.scope === "project" ? path.join(checkCwd(b.cwd), ".ci", "skills") : SKILLS_DIR;
		const dir = path.join(base, name);
		if (fs.existsSync(dir)) throw httpErr(409, `已存在：${dir}`);
		fs.mkdirSync(dir, { recursive: true });
		const desc = String(b.description || "").replace(/\r?\n/g, " ").trim();
		fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${desc}\n---\n\n${String(b.body || "").trim()}\n`);
		skills.cache.clear();
		broadcast({ kind: "skills" });
		return send(res, 200, { ok: true });
	}
	if (p === "/api/skills/file") {
		// 只允许操作技能目录下的 SKILL.md
		const file = path.resolve(String(q.path || ""));
		const parent = path.dirname(path.dirname(file));
		const okDir = samePath(parent, SKILLS_DIR) || /[\\/]\.ci[\\/]skills$/i.test(parent);
		if (path.basename(file) !== "SKILL.md" || !okDir || !fs.existsSync(file)) throw httpErr(400, "不是技能文件");
		if (m === "GET") return send(res, 200, { text: fs.readFileSync(file, "utf8") });
		if (m === "PUT") fs.writeFileSync(file, String((await readBody(req)).text ?? ""));
		else if (m === "DELETE") fs.rmSync(path.dirname(file), { recursive: true, force: true });
		skills.cache.clear();
		broadcast({ kind: "skills" });
		return send(res, 200, { ok: true });
	}

	if (p === "/api/skills" && m === "PUT") {
		const { id, enabled } = await readBody(req);
		const set = new Set(config.settings.disabledSkills || []);
		enabled ? set.delete(id) : set.add(id);
		config.settings.disabledSkills = [...set];
		saveConfig(config);
		broadcast({ kind: "skills" });
		return send(res, 200, { ok: true });
	}

	if (p === "/api/mcp/raw") {
		if (m === "GET") return send(res, 200, { text: fs.existsSync(MCP_FILE) ? fs.readFileSync(MCP_FILE, "utf8") : "" });
		if (m === "PUT") {
			const { text } = await readBody(req);
			try {
				JSON.parse(text);
			} catch (e) {
				throw httpErr(400, `JSON 格式错误：${e.message}`);
			}
			fs.writeFileSync(MCP_FILE, text);
			mcp.sync();
			return send(res, 200, { ok: true });
		}
	}
	if ((r = /^\/api\/mcp\/([^/]+)$/.exec(p)) && m === "PUT") {
		mcp.setEnabled(decodeURIComponent(r[1]), !!(await readBody(req)).enabled);
		return send(res, 200, { ok: true });
	}

	if (p === "/api/project-prompt") {
		const cwd = checkCwd(q.cwd);
		if (m === "GET") return send(res, 200, { text: loadProjectPrompt(cwd), default: DEFAULT_PROJECT_PROMPT, ...loadProjectSettings(cwd) });
		if (m === "PUT") {
			const b = await readBody(req);
			ensureProject(cwd);
			if (typeof b.text === "string") fs.writeFileSync(projectPromptFile(cwd), b.text);
			const patch = {};
			if (typeof b.tools === "boolean") patch.tools = b.tools;
			if (typeof b.memory === "boolean") patch.memory = b.memory;
			if (Array.isArray(b.memories)) patch.memories = b.memories;
			return send(res, 200, { ok: true, ...saveProjectSettings(cwd, patch) });
		}
	}

	throw httpErr(404, `未知接口：${m} ${p}`);
}

const server = http.createServer(async (req, res) => {
	syncConfig();
	try {
		if (!allowedHost(req.headers.host)) return send(res, 403, { error: "Host 不允许" });
		const url = new URL(req.url, `http://${req.headers.host}`);
		if (!url.pathname.startsWith("/api/")) return serveStatic(req, res, url.pathname);

		const origin = req.headers.origin;
		if (origin && !allowedHost(origin.replace(/^https?:\/\//, ""))) return send(res, 403, { error: "跨站请求被拒绝" });
		const token = req.headers["x-ci-token"] || url.searchParams.get("token");
		const a = Buffer.from(String(token || ""));
		const b = Buffer.from(TOKEN);
		if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return send(res, 401, { error: "令牌无效，请使用启动时输出的地址打开" });

		await api(req, res, url);
	} catch (e) {
		if (!res.headersSent) send(res, e.status || 500, { error: e.message });
		if (!e.status) console.error(e);
	}
});

mcp.watch();
server.listen(PORT, HOST, () => {
	const link = `http://${HOST}:${PORT}/#token=${TOKEN}`;
	console.log(`Ciallo Agent 已启动：${link}`);
	console.log("（仅本机可访问；令牌每次启动重新生成，可用环境变量 CI_TOKEN 固定）");
	if (!argv.includes("--no-open")) {
		if (IS_WIN) spawn("cmd", ["/c", "start", "", link.replace(/&/g, "^&")], { stdio: "ignore", detached: true }).unref();
		else spawn(process.platform === "darwin" ? "open" : "xdg-open", [link], { stdio: "ignore", detached: true }).unref();
	}
});

const shutdown = () => {
	mcp.stopAll();
	process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
