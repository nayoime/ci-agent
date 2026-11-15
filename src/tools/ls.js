import fs from "node:fs/promises";
import path from "node:path";
import { resolvePath, tokenLabel } from "./util.js";

export default {
	name: "ls",
	label: "列出目录",
	readOnly: true,
	description: "列出目录内容。文件后标注完整读取约需的 token（≈ 为估算，无 ≈ 为实测）。",
	parameters: {
		type: "object",
		properties: {
			path: { type: "string", description: "目录路径，默认工作目录" },
			limit: { type: "number", description: "最多条目数，默认 500" },
		},
	},
	claude: { name: "LS" },

	async run({ path: p, limit = 500 }, ctx) {
		const dir = resolvePath(p, ctx.cwd);
		const entries = await fs.readdir(dir, { withFileTypes: true }).catch((e) => {
			throw new Error(e.code === "ENOTDIR" ? `不是目录：${dir}` : `目录不存在：${dir}`);
		});
		const list = entries
			.filter((e) => e.name !== ".ci") // 代理自己的数据目录，不属于项目
			.sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
		if (!list.length) return "（空目录）";
		const shown = await Promise.all(
			list.slice(0, limit).map(async (e) => {
				if (e.isDirectory()) return e.name + "/";
				const full = path.join(dir, e.name);
				const st = await fs.stat(full).catch(() => null);
				return st?.isFile() ? `${e.name}  ${tokenLabel(ctx.cwd, full, st.size)}` : e.name;
			}),
		);
		if (list.length > limit) shown.push(`…（共 ${list.length} 项，只显示前 ${limit} 项）`);
		return shown.join("\n");
	},
};
