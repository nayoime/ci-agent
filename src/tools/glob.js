import fs from "node:fs/promises";
import path from "node:path";
import { resolvePath, IGNORED_DIRS, tokenLabel } from "./util.js";

export default {
	name: "glob",
	label: "查找文件",
	readOnly: true,
	description: "按 glob 模式查找文件（如 **/*.js），结果按修改时间从新到旧排序。文件后标注完整读取约需的 token（≈ 为估算，无 ≈ 为实测）。",
	parameters: {
		type: "object",
		properties: {
			pattern: { type: "string", description: "glob 模式" },
			path: { type: "string", description: "搜索目录，默认工作目录" },
			limit: { type: "number", description: "最多结果数，默认 200" },
		},
		required: ["pattern"],
	},
	claude: { name: "Glob" },

	async run({ pattern, path: p, limit = 200 }, ctx) {
		if (!pattern) throw new Error("pattern 不能为空");
		const base = resolvePath(p, ctx.cwd);
		const files = [];
		const exclude = (f) => f.split(/[\\/]/).some((seg) => IGNORED_DIRS.has(seg));
		for await (const f of fs.glob(pattern, { cwd: base, exclude })) {
			if (ctx.signal?.aborted) break;
			const full = path.join(base, f);
			const st = await fs.stat(full).catch(() => null);
			if (st?.isFile()) files.push({ full, mtime: st.mtimeMs, size: st.size });
			if (files.length > 5000) break;
		}
		if (!files.length) return `未找到匹配 ${pattern} 的文件（目录：${base}）`;
		files.sort((a, b) => b.mtime - a.mtime);
		const out = files.slice(0, limit).map((f) => `${f.full}  ${tokenLabel(ctx.cwd, f.full, f.size)}`);
		if (files.length > limit) out.push(`…（共 ${files.length} 个，只显示前 ${limit} 个）`);
		return out.join("\n");
	},
};
