// 记忆库：项目开启记忆后提供给主代理，模型自行判断哪些信息值得长期记住
import { loadProjectSettings, saveProjectSettings } from "../agent/context.js";

export default {
	name: "memory",
	label: "记忆",
	readOnly: true,
	description:
		"管理长期记忆库（跨会话保留）。对话中出现值得长期记住的信息（如用户的名字、喜好、长期约定）时用 add 记下；信息变了用 update 改；过时或错误的用 remove 删。index 是系统提示词里记忆的编号（从 1 开始）。每条记忆写成一句简短完整的话，尽量不用人称代词（我、你、他、用户），直接写名字，如“小明喜欢猫”。如果还不知道对方的名字，可以在合适的时候问一下，知道后先记下名字，并把已有记忆里的称呼改成名字。",
	parameters: {
		type: "object",
		properties: {
			action: { type: "string", enum: ["add", "update", "remove"], description: "add 新增 / update 修改 / remove 删除" },
			text: { type: "string", description: "记忆内容（add、update 需要）" },
			index: { type: "number", description: "要修改或删除的记忆编号（update、remove 需要）" },
		},
		required: ["action"],
	},
	claude: { name: "Memory" },

	async run({ action, text, index }, ctx) {
		const list = loadProjectSettings(ctx.cwd).memories;
		const t = String(text ?? "").trim();
		const i = Number(index) - 1;
		if (action === "add") {
			if (!t) return { content: "text 不能为空", isError: true };
			list.push(t);
		} else if (action === "update" || action === "remove") {
			if (!Number.isInteger(i) || i < 0 || i >= list.length) return { content: `编号 ${index} 不存在，当前共 ${list.length} 条`, isError: true };
			if (action === "update") {
				if (!t) return { content: "text 不能为空", isError: true };
				list[i] = t;
			} else list.splice(i, 1);
		} else return { content: `未知 action：${action}`, isError: true };
		saveProjectSettings(ctx.cwd, { memories: list });
		return `已保存。当前记忆：\n${list.map((m, k) => `${k + 1}. ${m}`).join("\n") || "（空）"}`;
	},
};
