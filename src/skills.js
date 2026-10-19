// 技能：<Ciallo Agent>/skills/<名称>/SKILL.md 与 <项目>/.ci/skills/<名称>/SKILL.md
// 开关存于 data/config.json 的 settings.disabledSkills，目录变化自动重新扫描
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { ROOT } from "./config.js";

export const SKILLS_DIR = path.join(ROOT, "skills");

function parseFrontmatter(text) {
	const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
	const meta = {};
	if (m) {
		for (const line of m[1].split(/\r?\n/)) {
			const kv = /^([\w-]+):\s*(.*)$/.exec(line);
			if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, "").trim();
		}
	}
	return meta;
}

function scanDir(dir, scope) {
	if (!fs.existsSync(dir)) return [];
	const out = [];
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		if (!e.isDirectory()) continue;
		const file = path.join(dir, e.name, "SKILL.md");
		if (!fs.existsSync(file)) continue;
		const meta = parseFrontmatter(fs.readFileSync(file, "utf8"));
		out.push({
			id: `${scope}:${meta.name || e.name}`,
			name: meta.name || e.name,
			description: meta.description || "（无描述）",
			path: file,
			scope,
		});
	}
	return out;
}

export class SkillManager extends EventEmitter {
	constructor(getDisabled) {
		super();
		this.getDisabled = getDisabled;
		this.cache = new Map(); // 项目目录 → 技能列表
		this.watched = new Set();
		fs.mkdirSync(SKILLS_DIR, { recursive: true });
		this.watchDir(SKILLS_DIR);
	}

	watchDir(dir) {
		let timer;
		try {
			fs.watch(dir, { recursive: true }, () => {
				clearTimeout(timer);
				timer = setTimeout(() => {
					this.cache.clear();
					this.emit("change");
				}, 300);
			});
		} catch {}
	}

	all(cwd) {
		const key = cwd || "";
		if (!this.cache.has(key)) {
			const list = [...scanDir(SKILLS_DIR, "全局")];
			if (cwd) {
				const projDir = path.join(cwd, ".ci", "skills");
				if (fs.existsSync(projDir) && !this.watched.has(projDir)) {
					this.watched.add(projDir);
					this.watchDir(projDir);
				}
				list.push(...scanDir(projDir, "项目"));
			}
			this.cache.set(key, list);
		}
		const disabled = new Set(this.getDisabled());
		return this.cache.get(key).map((s) => ({ ...s, enabled: !disabled.has(s.id) }));
	}

	enabled(cwd) {
		return this.all(cwd).filter((s) => s.enabled);
	}
}
