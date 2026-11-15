// 上下文压缩：把较早的消息滚动摘要成一条用户消息，保留最近 keepRecent token 原文
import { streamModel } from "../protocol/index.js";
import { estimateMessage, estimateText } from "./tokens.js";

const SUMMARY_SYSTEM = `你负责把编程代理的对话历史压缩成摘要，供代理继续工作。
要求：
- 用中文，条理清晰，只写事实，不要客套。
- 必须保留：用户的目标和要求、已做的决定、改过的文件路径和改动要点、读过哪些文件及从中得出的结论、重要的命令结果和报错、未完成的事项。
- 文件路径、函数名、命令、报错信息保持原样。
- 不需要保留：已经过时的尝试细节、文件内容本身（压缩后代理需要时会重新读取）。
按以下结构输出：
## 目标
## 已完成
## 关键信息（文件、决定、发现）
## 待办`;

/** 头尾保留、中间省略（只留开头会让模型误判输出的结尾） */
function clipMiddle(s, max) {
	return s.length > max ? `${s.slice(0, max * 0.6)}\n…（中间省略 ${s.length - max} 字）…\n${s.slice(-max * 0.4)}` : s;
}

/**
 * 工具结果按类型处理：读文件、列目录的内容可以重新获取，摘要不该记，只留一行记录；
 * 命令、搜索等结果无法免费重现，压短保留；去掉附给模型的上下文状况
 */
function serializeTool(m, args = {}, maxTool) {
	const c = m.content.replace(/\n\n〔上下文 [^〕]*〕$/, "");
	const head = `【工具结果 ${m.name}${m.isError ? " 出错" : ""}】`;
	if (!m.isError && m.name === "read") {
		const range = args.offset ? `，从第 ${args.offset} 行起` : "";
		return `${head}已读取 ${args.path ?? ""}${range}（约 ${estimateText(c)} token，内容略）`;
	}
	if (!m.isError && (m.name === "ls" || m.name === "glob")) return `${head}已列出 ${args.pattern ?? args.path ?? "."}（结果略）`;
	return `${head}\n${clipMiddle(c, maxTool)}`;
}

/** 消息序列化为纯文本，用于摘要；calls：调用 ID → 参数 */
function serialize(m, calls, maxTool = 500) {
	if (m.role === "user") {
		const t = typeof m.content === "string" ? m.content : m.content.map((b) => b.text || "[图片]").join("\n");
		return `【用户】\n${t}`;
	}
	if (m.role === "tool") return serializeTool(m, calls.get(m.id), maxTool);
	const parts = [];
	for (const b of m.content) {
		if (b.type === "text" && b.text) parts.push(b.text);
		if (b.type === "tool_call") parts.push(`[调用 ${b.name}] ${JSON.stringify(b.args).slice(0, 600)}`);
	}
	return `【助手】\n${parts.join("\n")}`;
}

/** 找切分点：尾部保留约 keepRecent token，且切在 user/assistant 消息开头（不拆散工具调用与结果） */
export function findCut(messages, keepRecent) {
	let acc = 0;
	let cut = messages.length;
	for (let i = messages.length - 1; i >= 0; i--) {
		acc += estimateMessage(messages[i]);
		if (acc > keepRecent) break;
		cut = i;
	}
	while (cut < messages.length && messages[cut].role === "tool") cut++;
	// 至少保留最后一条消息之后的内容；无可压缩内容返回 0
	if (cut >= messages.length) {
		cut = messages.length - 1;
		while (cut > 0 && messages[cut].role === "tool") cut--;
	}
	return cut;
}

async function summarize(model, text, { previous, focus, signal }) {
	let prompt = "";
	if (previous) prompt += `此前的摘要：\n${previous}\n\n之后的新对话：\n`;
	prompt += `${text}\n\n请输出合并后的完整摘要。`;
	if (focus) prompt += `\n重点保留：${focus}`;
	let out = "";
	for await (const ev of streamModel(model, {
		system: SUMMARY_SYSTEM,
		messages: [{ role: "user", content: prompt }],
		tools: [],
		codec: null,
		signal,
		maxTokens: Math.min(3000, model.maxOutput),
		thinking: "off",
	})) {
		if (ev.type === "done") out = ev.message.content.filter((b) => b.type === "text").map((b) => b.text).join("");
	}
	return out.trim();
}

/**
 * 压缩消息列表，返回新列表（不修改原数组）。
 * 历史过长时分块滚动摘要，保证每次摘要请求不超过模型上下文。
 */
export async function compactMessages(model, messages, { focus, signal, summarizer, scale = 1 } = {}) {
	// scale：真实 token / 估算值。估算偏低时（代码、JSON 较多）按比例少留一些，否则压缩后马上又超线
	const cut = findCut(messages, model.keepRecent / scale);
	if (cut <= 0) return null;
	const head = messages.slice(0, cut);
	const tail = messages.slice(cut);
	// 切分点按主模型算；摘要请求可以交给单独配置的压缩模型
	model = summarizer || model;

	const budget = Math.max(2000, model.contextWindow - Math.min(3000, model.maxOutput) - 2500);
	let summary = "";
	let chunk = [];
	let chunkTokens = 0;
	const flush = async () => {
		if (!chunk.length) return;
		summary = await summarize(model, chunk.join("\n\n"), { previous: summary, focus, signal });
		chunk = [];
		chunkTokens = 0;
	};
	const calls = new Map();
	for (const m of head) if (m.role === "assistant") for (const b of m.content) if (b.type === "tool_call") calls.set(b.id, b.args);
	for (const m of head) {
		if (m.summary) {
			summary = typeof m.content === "string" ? m.content.replace(/^<历史摘要>\n?|\n?<\/历史摘要>[\s\S]*$/g, "") : "";
			continue;
		}
		const s = serialize(m, calls);
		const t = estimateText(s);
		if (chunkTokens + t + estimateText(summary) > budget) await flush();
		chunk.push(t > budget ? s.slice(0, budget * 2) : s);
		chunkTokens += Math.min(t, budget);
	}
	await flush();
	if (!summary) throw new Error("摘要生成失败（模型返回为空）");

	const summaryMsg = {
		role: "user",
		summary: true,
		content: `<历史摘要>\n${summary}\n</历史摘要>\n以上是此前对话的摘要，请在此基础上继续。`,
	};
	return { messages: [summaryMsg, ...tail], removed: head.length, summary };
}
