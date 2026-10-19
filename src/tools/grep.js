import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { resolvePath, findRg, truncate, isBinary, IGNORED_DIRS } from "./util.js";

function runRg(args, cwd, signal) {
	return new Promise((resolve, reject) => {
		const child = spawn(findRg(), args, { cwd, windowsHide: true });
		let out = "";
		let err = "";
		child.stdout.on("data", (d) => {
			out += d;
			if (out.length > 2_000_000) child.kill();
		});
		child.stderr.on("data", (d) => (err += d));
		signal?.addEventListener("abort", () => child.kill(), { once: true });
		child.on("error", reject);
		child.on("close", (code) => (code > 1 && !out ? reject(new Error(err.trim() || `rg 退出码 ${code}`)) : resolve(out)));
	});
}

/** 无 rg 时的纯 JS 回退 */
async function jsGrep({ pattern, base, glob, ignoreCase, mode }, signal) {
	const re = new RegExp(pattern, ignoreCase ? "i" : "");
	const results = [];
	const iter = fs.glob(glob || "**/*", { cwd: base, exclude: (f) => f.split(/[\\/]/).some((s) => IGNORED_DIRS.has(s)) });
	for await (const rel of iter) {
		if (signal?.aborted || results.length > 5000) break;
		const full = path.join(base, rel);
		const buf = await fs.readFile(full).catch(() => null);
		if (!buf || isBinary(buf)) continue;
		const lines = buf.toString("utf8").split(/\r?\n/);
		let count = 0;
		lines.forEach((l, i) => {
			if (re.test(l)) {
				count++;
				if (mode === "content") results.push(`${full}:${i + 1}:${l}`);
			}
		});
		if (count && mode === "files") results.push(full);
		if (count && mode === "count") results.push(`${full}:${count}`);
	}
	return results.join("\n");
}

export default {
	name: "grep",
	label: "搜索内容",
	readOnly: true,
	description: "用正则搜索文件内容（ripgrep）。outputMode：content 显示匹配行（默认），files 只列文件，count 统计次数。",
	parameters: {
		type: "object",
		properties: {
			pattern: { type: "string", description: "正则表达式" },
			path: { type: "string", description: "搜索目录或文件，默认工作目录" },
			glob: { type: "string", description: "文件过滤，如 *.js 或 **/*.{ts,tsx}" },
			ignoreCase: { type: "boolean", description: "忽略大小写" },
			context: { type: "number", description: "显示匹配行前后各几行" },
			outputMode: { type: "string", enum: ["content", "files", "count"], description: "输出模式" },
			limit: { type: "number", description: "最多输出行数，默认 200" },
		},
		required: ["pattern"],
	},
	claude: {
		name: "Grep",
		parameters: {
			type: "object",
			properties: {
				pattern: { type: "string", description: "正则表达式" },
				path: { type: "string", description: "搜索目录或文件" },
				glob: { type: "string", description: "文件过滤，如 *.js" },
				output_mode: { type: "string", enum: ["content", "files_with_matches", "count"], description: "输出模式，默认 files_with_matches" },
				"-i": { type: "boolean", description: "忽略大小写" },
				"-C": { type: "number", description: "上下文行数" },
				head_limit: { type: "number", description: "最多输出行数" },
			},
			required: ["pattern"],
		},
		toWire: (a) => ({
			pattern: a.pattern,
			path: a.path,
			glob: a.glob,
			output_mode: a.outputMode === "files" ? "files_with_matches" : a.outputMode,
			"-i": a.ignoreCase,
			"-C": a.context,
			head_limit: a.limit,
		}),
	},
	normalize(a) {
		const mode = a.outputMode ?? a.output_mode;
		return {
			pattern: a.pattern ?? a.regex ?? a.query,
			path: a.path,
			glob: a.glob ?? a.include,
			ignoreCase: a.ignoreCase ?? a["-i"] ?? a.ignore_case,
			context: a.context ?? a["-C"],
			outputMode: mode === "files_with_matches" ? "files" : mode,
			limit: a.limit ?? a.head_limit,
		};
	},

	async run({ pattern, path: p, glob, ignoreCase, context, outputMode = "content", limit = 200 }, ctx) {
		if (!pattern) throw new Error("pattern 不能为空");
		const target = resolvePath(p, ctx.cwd);
		const stat = await fs.stat(target).catch(() => null);
		if (!stat) throw new Error(`路径不存在：${target}`);
		const cwd = stat.isDirectory() ? target : path.dirname(target);

		let out;
		if (findRg()) {
			const args = ["--color=never", "--no-heading", "--with-filename", "-n", "--max-columns=500", "--max-columns-preview"];
			for (const d of IGNORED_DIRS) args.push("-g", `!${d}/`);
			if (ignoreCase) args.push("-i");
			if (glob) args.push("-g", glob);
			if (outputMode === "files") args.push("-l");
			if (outputMode === "count") args.push("-c");
			if (context && outputMode === "content") args.push("-C", String(context));
			// 传绝对路径，rg 输出即为绝对路径，避免模型混淆
			args.push("-e", pattern, "--", target);
			out = await runRg(args, cwd, ctx.signal);
		} else {
			out = await jsGrep({ pattern, base: cwd, glob, ignoreCase, mode: outputMode }, ctx.signal);
		}
		out = out.trimEnd();
		if (!out) return `未找到匹配：${pattern}`;
		return truncate(out, { maxLines: limit });
	},
};
