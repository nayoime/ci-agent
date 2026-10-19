// 会话持久化：<项目>/.ci/sessions/<id>.jsonl，每行一条记录
import fs from "node:fs";
import path from "node:path";
import { ensureProject, projectDir } from "./context.js";

function newId() {
	const d = new Date();
	const pad = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${Math.random().toString(36).slice(2, 6)}`;
}

export class Session {
	constructor(cwd, id) {
		ensureProject(cwd);
		this.cwd = cwd;
		this.id = id || newId();
		this.file = path.join(projectDir(cwd), "sessions", `${this.id}.jsonl`);
	}

	append(entry) {
		fs.appendFileSync(this.file, JSON.stringify({ t: Date.now(), ...entry }) + "\n");
	}

	/** 回放记录得到消息列表 */
	load() {
		if (!fs.existsSync(this.file)) return { messages: [], meta: {}, statsFrom: 0 };
		let messages = [];
		let meta = {};
		let statsFrom = 0; // 最近一次重置后的消息下标（之前的 token 统计已失效）
		for (const line of fs.readFileSync(this.file, "utf8").split("\n")) {
			if (!line.trim()) continue;
			let e;
			try {
				e = JSON.parse(line);
			} catch {
				continue;
			}
			if (e.type === "meta") meta = { ...meta, ...e.meta };
			else if (e.type === "message") messages.push(e.message);
			else if (e.type === "reset") (messages = e.messages), (statsFrom = messages.length);
		}
		return { messages, meta, statsFrom };
	}

	static list(cwd) {
		const dir = path.join(projectDir(cwd), "sessions");
		if (!fs.existsSync(dir)) return [];
		return fs
			.readdirSync(dir)
			.filter((f) => f.endsWith(".jsonl"))
			.map((f) => {
				const file = path.join(dir, f);
				const id = f.slice(0, -6);
				let title = "";
				let meta = {};
				// 只读前 64KB 找标题
				const fd = fs.openSync(file, "r");
				const buf = Buffer.alloc(65536);
				const n = fs.readSync(fd, buf, 0, buf.length, 0);
				fs.closeSync(fd);
				for (const line of buf.subarray(0, n).toString("utf8").split("\n")) {
					try {
						const e = JSON.parse(line);
						if (e.type === "meta") meta = { ...meta, ...e.meta };
						if (!title && e.type === "message" && e.message.role === "user") {
							const c = e.message.content;
							title = (typeof c === "string" ? c : c.find((b) => b.type === "text")?.text || "").slice(0, 60);
						}
					} catch {}
				}
				return { id, title: meta.title || title || "（空会话）", mtime: fs.statSync(file).mtimeMs, model: meta.model };
			})
			.sort((a, b) => b.mtime - a.mtime);
	}
}
