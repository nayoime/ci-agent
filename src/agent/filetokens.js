// 文件 token 记录：<项目>/.ci/tokens.json，按相对路径记录读取该文件的实测代价
// API 只给整次请求的输入 token，所以只在“一轮只读了一个文件”时，用两次请求的输入差值反推这次读取的真实 token。
// 记录 scale（实测 / 估算）与 perByte（实测 / 读取字节数），文件改动后比例基本不变，所以不按修改时间失效。
import fs from "node:fs";
import path from "node:path";
import { projectDir } from "./context.js";

export const DEFAULT_PER_BYTE = 0.36; // 未实测时按字节估算读取代价（含行号），中英文都接近这个值
const MAX_ENTRIES = 2000;
const cache = new Map(); // cwd → { data, mtime }

const storeFile = (cwd) => path.join(projectDir(cwd), "tokens.json");
const keyOf = (cwd, abs) => {
	const rel = path.relative(cwd, abs);
	return (rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : abs).replace(/\\/g, "/");
};

function load(cwd) {
	const f = storeFile(cwd);
	let mtime = 0;
	try {
		mtime = fs.statSync(f).mtimeMs;
	} catch {}
	const c = cache.get(cwd);
	if (c && c.mtime === mtime) return c.data;
	let data = {};
	try {
		data = JSON.parse(fs.readFileSync(f, "utf8")) || {};
	} catch {}
	cache.set(cwd, { data, mtime });
	return data;
}

/** 读取某文件的实测记录：{ scale, perByte } 或 null */
export function getFileStat(cwd, abs) {
	return load(cwd)[keyOf(cwd, abs)] || null;
}

/** 记录一次实测 */
export function recordFileStat(cwd, abs, { scale, perByte }) {
	const data = load(cwd);
	data[keyOf(cwd, abs)] = { scale: +scale.toFixed(3), perByte: +perByte.toFixed(4), at: Date.now() };
	const keys = Object.keys(data);
	if (keys.length > MAX_ENTRIES) {
		keys.sort((a, b) => data[a].at - data[b].at);
		for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) delete data[k];
	}
	try {
		fs.mkdirSync(projectDir(cwd), { recursive: true });
		const f = storeFile(cwd);
		fs.writeFileSync(f, JSON.stringify(data));
		cache.set(cwd, { data, mtime: fs.statSync(f).mtimeMs });
	} catch {}
}

/** 按文件大小估算读取整个文件的 token；返回 { tokens, measured } */
export function fileTokens(cwd, abs, size) {
	const s = getFileStat(cwd, abs);
	return { tokens: Math.round(size * (s?.perByte || DEFAULT_PER_BYTE)), measured: !!s };
}

/** 1234 → "1.2k"，56789 → "57k" */
export const fmtTokens = (n) => (n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.max(0, Math.round(n))));
