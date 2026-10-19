import fs from "node:fs/promises";
import path from "node:path";
import { resolvePath } from "./util.js";

export default {
	name: "write",
	label: "写入文件",
	description: "新建文件或整体覆盖文件，自动创建父目录。",
	parameters: {
		type: "object",
		properties: {
			path: { type: "string", description: "文件路径" },
			content: { type: "string", description: "完整文件内容" },
		},
		required: ["path", "content"],
	},
	claude: { name: "Write", rename: { file_path: "path" } },

	async run({ path: p, content }, ctx) {
		if (typeof content !== "string") throw new Error("content 必须是字符串");
		const file = resolvePath(p, ctx.cwd);
		const existed = await fs.stat(file).then(() => true, () => false);
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(file, content, "utf8");
		const lines = content.split("\n").length;
		return { content: `已${existed ? "覆盖" : "创建"} ${file}（${lines} 行）`, details: { file, created: !existed } };
	},
};
