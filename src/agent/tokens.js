// 粗略 token 估算（偏保守）：中日韩字符约 0.8 token/字，其他约 3.2 字符/token
export function estimateText(s) {
	if (!s) return 0;
	const str = String(s);
	const cjk = (str.match(/[\u3000-\u9fff\uac00-\ud7af\uff00-\uffef]/g) || []).length;
	return Math.ceil(cjk * 0.8 + (str.length - cjk) / 3.2);
}

export function estimateMessage(m) {
	let n = 4;
	if (typeof m.content === "string") return n + estimateText(m.content);
	for (const b of m.content || []) {
		// 思考内容大多不回传给模型（OpenAI 兼容、Gemini），只有带签名的（Anthropic）会占上下文
		if (b.type === "text" || (b.type === "thinking" && b.signature)) n += estimateText(b.text);
		else if (b.type === "tool_call") n += 10 + estimateText(b.name) + estimateText(JSON.stringify(b.args));
		else if (b.type === "image") n += 1000;
	}
	return n;
}

export function estimateMessages(list) {
	return list.reduce((s, m) => s + estimateMessage(m), 0);
}
