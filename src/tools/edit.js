import fs from "node:fs/promises";
import { resolvePath } from "./util.js";

function countOf(hay, needle) {
	let n = 0;
	for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) n++;
	return n;
}

export default {
	name: "edit",
	label: "编辑文件",
	description:
		"按原文精确替换文件内容。oldText 必须与文件内容完全一致且唯一（除非 replaceAll）。一次可提交多处互不重叠的修改。",
	parameters: {
		type: "object",
		properties: {
			path: { type: "string", description: "文件路径" },
			edits: {
				type: "array",
				description: "替换列表，按顺序执行",
				items: {
					type: "object",
					properties: {
						oldText: { type: "string", description: "要替换的原文" },
						newText: { type: "string", description: "替换后的文本" },
						replaceAll: { type: "boolean", description: "替换所有匹配（默认 false）" },
					},
					required: ["oldText", "newText"],
				},
			},
		},
		required: ["path", "edits"],
	},
	// Claude Code 风格：单处替换 { file_path, old_string, new_string, replace_all }
	claude: {
		name: "Edit",
		parameters: {
			type: "object",
			properties: {
				file_path: { type: "string", description: "文件路径" },
				old_string: { type: "string", description: "要替换的原文" },
				new_string: { type: "string", description: "替换后的文本" },
				replace_all: { type: "boolean", description: "替换所有匹配（默认 false）" },
			},
			required: ["file_path", "old_string", "new_string"],
		},
		toWire: (a) => {
			const e = a.edits?.[0] || {};
			return { file_path: a.path, old_string: e.oldText, new_string: e.newText, ...(e.replaceAll ? { replace_all: true } : {}) };
		},
	},
	/** 兼容两种风格及常见变体 */
	normalize(a) {
		const path = a.path ?? a.file_path ?? a.filePath;
		const one = (e) => ({
			oldText: e.oldText ?? e.old_string ?? e.old_text ?? e.old,
			newText: e.newText ?? e.new_string ?? e.new_text ?? e.new ?? "",
			replaceAll: e.replaceAll ?? e.replace_all ?? false,
		});
		let edits = a.edits;
		if (typeof edits === "string") {
			try {
				edits = JSON.parse(edits);
			} catch {}
		}
		return { path, edits: Array.isArray(edits) ? edits.map(one) : [one(a)] };
	},

	async run({ path: p, edits }, ctx) {
		const file = resolvePath(p, ctx.cwd);
		let text = await fs.readFile(file, "utf8").catch(() => {
			throw new Error(`文件不存在：${file}`);
		});
		const crlf = text.includes("\r\n");
		if (crlf) text = text.replace(/\r\n/g, "\n");

		let total = 0;
		for (const [i, e] of edits.entries()) {
			const label = edits.length > 1 ? `第 ${i + 1} 处：` : "";
			if (typeof e.oldText !== "string" || e.oldText === "") throw new Error(`${label}oldText 不能为空`);
			const oldText = e.oldText.replace(/\r\n/g, "\n");
			const newText = String(e.newText ?? "").replace(/\r\n/g, "\n");
			const n = countOf(text, oldText);
			if (n === 0) throw new Error(`${label}未找到 oldText。请先 read 文件，确认原文（含缩进、空格）完全一致。`);
			if (n > 1 && !e.replaceAll) throw new Error(`${label}oldText 匹配到 ${n} 处，请加入更多上下文使其唯一，或设置 replaceAll。`);
			text = e.replaceAll ? text.split(oldText).join(newText) : text.replace(oldText, () => newText);
			total += e.replaceAll ? n : 1;
		}
		await fs.writeFile(file, crlf ? text.replace(/\n/g, "\r\n") : text, "utf8");
		return { content: `已在 ${file} 中替换 ${total} 处`, details: { file, edits } };
	},
};
