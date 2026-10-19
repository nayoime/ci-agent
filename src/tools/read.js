import fs from "node:fs/promises";
import { resolvePath, isBinary, MAX_BYTES } from "./util.js";

export default {
	name: "read",
	label: "读取文件",
	readOnly: true,
	description: "读取文本文件，输出带行号。大文件用 offset/limit 分段读取（默认最多 2000 行）。",
	parameters: {
		type: "object",
		properties: {
			path: { type: "string", description: "文件路径（相对或绝对）" },
			offset: { type: "number", description: "起始行号，从 1 开始" },
			limit: { type: "number", description: "最多读取行数" },
		},
		required: ["path"],
	},
	claude: { name: "Read", rename: { file_path: "path" } },

	async run({ path: p, offset = 1, limit = 2000 }, ctx) {
		const file = resolvePath(p, ctx.cwd);
		const stat = await fs.stat(file).catch(() => null);
		if (!stat) throw new Error(`文件不存在：${file}`);
		if (stat.isDirectory()) throw new Error(`这是目录，请用 ls：${file}`);
		const buf = await fs.readFile(file);
		if (isBinary(buf)) return `二进制文件（${stat.size} 字节），无法以文本读取：${file}`;

		const lines = buf.toString("utf8").replace(/\r\n/g, "\n").split("\n");
		const start = Math.max(1, Math.floor(offset));
		const max = Math.max(1, Math.min(Math.floor(limit), 2000));
		if (start > lines.length) return `文件共 ${lines.length} 行，offset ${start} 超出范围`;

		const out = [];
		let bytes = 0;
		let end = start - 1;
		for (let i = start - 1; i < Math.min(lines.length, start - 1 + max); i++) {
			let line = lines[i];
			if (line.length > 2000) line = line.slice(0, 2000) + "…（行过长已截断）";
			const row = `${String(i + 1).padStart(6)}\t${line}`;
			bytes += Buffer.byteLength(row) + 1;
			if (bytes > MAX_BYTES) break;
			out.push(row);
			end = i + 1;
		}
		if (end < lines.length) out.push(`\n（第 ${start}-${end} 行，共 ${lines.length} 行；继续读取请用 offset=${end + 1}）`);
		return out.join("\n") || "（空文件）";
	},
};
