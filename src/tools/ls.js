import fs from "node:fs/promises";
import { resolvePath } from "./util.js";

export default {
	name: "ls",
	label: "列出目录",
	readOnly: true,
	description: "列出目录内容。",
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
		const names = entries
			.filter((e) => e.name !== ".ci") // 代理自己的数据目录，不属于项目
			.map((e) => (e.isDirectory() ? e.name + "/" : e.name))
			.sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));
		if (!names.length) return "（空目录）";
		const shown = names.slice(0, limit);
		if (names.length > limit) shown.push(`…（共 ${names.length} 项，只显示前 ${limit} 项）`);
		return shown.join("\n");
	},
};
