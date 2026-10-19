// 系统提示词（简单中文）。{工具名} 占位符按模型的工具风格替换成实际名称。
import os from "node:os";

// 工具用途：只说干什么，不限定用法
const PURPOSE = {
	read: "读取文件",
	write: "新建或覆盖文件",
	edit: "按原文替换文件内容",
	bash: "执行命令",
	ls: "列出目录",
	glob: "按模式查找文件",
	grep: "搜索文件内容",
	subagent: "把独立任务交给子代理并行处理",
	toolsearch: "搜索并加载扩展工具",
	compact: "压缩较早的对话，释放上下文",
};

const BASE = `工具：
{TOOLS}

工作方式：
- 用户没说明的情况下不要备份，不用做安全检查。
- 多个互不依赖的工具调用，可以放在同一轮一起发出。
`;

const SUB = `你是一个 agent 子代理，负责主代理分配的一个子任务。

工具：
{TOOLS}

- 专注完成任务，不要做任务范围外的事。
- 完成后给出完整的结论、这是主代理唯一能看到的内容。`;

export function buildSystemPrompt({ cwd, tools, codec, projectFiles = [], skills = [], subagent = false, shell, deferred = [], projectPrompt = "", memory = null }) {
	const names = new Set(tools.map((t) => t.name));
	const lines = Object.keys(PURPOSE).filter((n) => names.has(n)).map((n) => `- {${n}}：${PURPOSE[n]}`);
	// 只列名字（省 token），让模型知道有哪些扩展工具可加载
	const byServer = {};
	for (const t of deferred) (byServer[t.server] ||= []).push(t.shortName || t.name);
	if (names.has("toolsearch"))
		for (const [srv, ns] of Object.entries(byServer)) lines.push(`  - ${srv}：${ns.slice(0, 30).join("、")}${ns.length > 30 ? ` 等 ${ns.length} 个` : ""}`);
	let text = (subagent ? SUB : BASE).replace("{TOOLS}", lines.join("\n"));
	text = text.replace(/\{([a-z]+)\}/g, (m, n) => (names.has(n) ? codec.wireName(n) : m));

	text += `\n\n环境：
- 系统：${os.type()} ${os.release()}（${process.platform}）
- shell：${shell || "bash"}
- 工作目录：${cwd}
- ${cwd}/.ci 是本助手自己的数据目录（会话记录等），不属于项目，查看或分析项目时忽略它，不要读取或修改
- 日期：${new Date().toLocaleDateString("zh-CN")}`;

	if (skills.length) {
		text += `\n\n技能：以下是可用的专项指引。任务符合描述时，先用 ${codec.wireName("read")} 读取对应 SKILL.md 再按其中说明操作。\n<skills>\n`;
		text += skills.map((s) => `<skill name="${s.name}" path="${s.path}">${s.description}</skill>`).join("\n");
		text += "\n</skills>";
	}

	for (const f of projectFiles) {
		text += `\n\n项目说明（${f.path}）：\n${f.content.trim()}`;
	}
	text += memorySection(memory, codec);
	// 项目提示词拼在最前面（只给主代理）
	if (projectPrompt.trim()) text = `${projectPrompt.trim()}\n\n${text}`;
	return text;
}

/** 记忆库段落；memory 为 null 表示未启用 */
function memorySection(memory, codec) {
	if (!memory) return "";
	const list = memory.length ? memory.map((m, i) => `${i + 1}. ${m}`).join("\n") : "（暂无）";
	return `\n\n记忆库（跨会话保留）：\n${list}\n对话中出现值得长期记住的信息（如用户的名字、喜好、长期约定）时，用 ${codec.wireName("memory")} 记下；已有记忆变了就修改，过时的删除。不用每轮都记，也不必告诉用户你记了。`;
}

/** 纯对话模式（关闭工具）：只有项目提示词和记忆库 */
export function buildChatPrompt({ projectPrompt = "", memory = null, codec }) {
	return `${projectPrompt.trim()}${memorySection(memory, codec)}`.trim();
}
