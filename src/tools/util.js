// 工具公共函数
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { fileTokens, fmtTokens } from "../agent/filetokens.js";

export const IS_WIN = process.platform === "win32";
export const MAX_LINES = 2000;
export const MAX_BYTES = 50 * 1024;
export const IGNORED_DIRS = new Set(["node_modules", ".git", ".ci", "dist", "build", "__pycache__", ".venv", ".next"]);

/** 解析路径：支持相对路径、~、MSYS 风格 /d/foo */
export function resolvePath(p, cwd) {
	if (p == null || p === "") return cwd;
	let s = String(p).trim().replace(/^["']|["']$/g, "");
	if (s.startsWith("~")) s = path.join(process.env.USERPROFILE || process.env.HOME || "", s.slice(1));
	if (IS_WIN) {
		const m = /^\/([a-zA-Z])(\/|$)(.*)/.exec(s);
		if (m) s = `${m[1].toUpperCase()}:\\${m[3]}`;
	}
	return path.resolve(cwd, s);
}

/** 输出截断：保留头部（head）或尾部（tail） */
export function truncate(text, { mode = "head", maxLines = MAX_LINES, maxBytes = MAX_BYTES } = {}) {
	let lines = text.split("\n");
	let note = "";
	if (lines.length > maxLines) {
		const total = lines.length;
		lines = mode === "tail" ? lines.slice(-maxLines) : lines.slice(0, maxLines);
		note = `（共 ${total} 行，已${mode === "tail" ? "只保留最后" : "只显示前"} ${maxLines} 行）`;
	}
	let out = lines.join("\n");
	if (Buffer.byteLength(out) > maxBytes) {
		const buf = Buffer.from(out);
		out = mode === "tail" ? buf.subarray(buf.length - maxBytes).toString() : buf.subarray(0, maxBytes).toString();
		note = `（输出超过 ${maxBytes / 1024}KB，已截断）`;
	}
	return note ? (mode === "tail" ? `${note}\n${out}` : `${out}\n${note}`) : out;
}

/** 文件完整读取的 token 标注：实测过的不带 ≈ */
export function tokenLabel(cwd, file, size) {
	const { tokens, measured } = fileTokens(cwd, file, size);
	return `${measured ? "" : "≈"}${fmtTokens(tokens)}`;
}

export function isBinary(buf) {
	const n = Math.min(buf.length, 8000);
	for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
	return false;
}

let rgPath;
/** 查找 ripgrep，找不到返回 null */
export function findRg() {
	if (rgPath !== undefined) return rgPath;
	const r = spawnSync(IS_WIN ? "where" : "which", ["rg"], { encoding: "utf8" });
	rgPath = r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() : null;
	return rgPath;
}

let shellPath;
/** 查找 bash：优先 Git Bash，排除 WSL 的 System32\bash.exe */
export function findShell(custom) {
	if (custom) return custom;
	if (shellPath) return shellPath;
	if (!IS_WIN) return (shellPath = fs.existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh");
	const candidates = [
		"C:\\Program Files\\Git\\bin\\bash.exe",
		"C:\\Program Files (x86)\\Git\\bin\\bash.exe",
		"D:\\Git\\bin\\bash.exe",
	];
	const r = spawnSync("where", ["bash"], { encoding: "utf8" });
	if (r.status === 0) candidates.push(...r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
	const git = spawnSync("where", ["git"], { encoding: "utf8" });
	if (git.status === 0) {
		for (const g of git.stdout.split(/\r?\n/).filter(Boolean)) {
			candidates.push(path.join(path.dirname(path.dirname(g.trim())), "bin", "bash.exe"));
		}
	}
	shellPath = candidates.find((c) => fs.existsSync(c) && !/system32/i.test(c)) || "powershell.exe";
	return shellPath;
}
