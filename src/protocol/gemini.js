// Google Gemini 原生接口适配器（generativelanguage.googleapis.com，streamGenerateContent）
import { readSSE, httpError } from "./sse.js";

/** 内部消息 → Gemini contents。工具调用没有 id，按顺序配对；思考签名需原样回传 */
function toWire(messages, codec) {
	const out = [];
	const push = (role, parts) => {
		if (!parts.length) return;
		const last = out[out.length - 1];
		if (last && last.role === role) last.parts.push(...parts); // 合并同角色相邻消息（含多个工具结果）
		else out.push({ role, parts });
	};
	for (const m of messages) {
		if (m.role === "user") {
			const parts =
				typeof m.content === "string"
					? [{ text: m.content }]
					: m.content.map((b) => (b.type === "image" ? { inlineData: { mimeType: b.mime, data: b.data } } : { text: b.text }));
			push("user", parts.filter((p) => p.inlineData || p.text));
		} else if (m.role === "assistant") {
			const parts = [];
			for (const b of m.content) {
				const sig = b.signature ? { thoughtSignature: b.signature } : {};
				if (b.type === "text" && (b.text || b.signature)) parts.push({ text: b.text || "", ...sig });
				else if (b.type === "tool_call") {
					const w = codec.encode(b.name, b.args);
					parts.push({ functionCall: { name: w.name, args: w.args || {} }, ...sig });
				}
			}
			push("model", parts);
		} else if (m.role === "tool") {
			push("user", [{ functionResponse: { name: codec.wireName(m.name), response: m.isError ? { error: m.content } : { result: m.content } } }]);
		}
	}
	return out;
}

const merge = (a, b) => {
	const o = { ...a };
	for (const [k, v] of Object.entries(b || {})) o[k] = v && typeof v === "object" && !Array.isArray(v) && typeof o[k] === "object" ? merge(o[k], v) : v;
	return o;
};

let seq = 0;

export async function* streamGemini(model, { system, messages, tools, codec, signal, maxTokens, extraBody }) {
	const p = model.provider;
	let body = {
		contents: toWire(messages, codec),
		generationConfig: { maxOutputTokens: maxTokens ?? model.maxOutput, thinkingConfig: { includeThoughts: true } },
	};
	if (system) body.systemInstruction = { parts: [{ text: system }] };
	// 用 parametersJsonSchema 直接传完整 JSON Schema，免得 MCP 工具的 schema 不兼容 OpenAPI 子集
	if (tools?.length) body.tools = [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters })) }];
	body = merge(merge(body, model.extraBody), extraBody);

	const base = (p.baseUrl || "https://generativelanguage.googleapis.com").replace(/\/$/, "");
	const root = /\/v1(beta|alpha)?$/.test(base) ? base : base + "/v1beta";
	const url = `${root}/models/${encodeURIComponent(model.model)}:streamGenerateContent?alt=sse`;
	const res = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json", "x-goog-api-key": p.apiKey, ...(p.headers || {}) },
		body: JSON.stringify(body),
		signal,
	});
	if (!res.ok) throw await httpError(res);

	const content = [];
	const usage = { input: 0, output: 0, cacheRead: 0 };
	let finish = "STOP";
	const last = () => content[content.length - 1];

	for await (const { data } of readSSE(res, signal)) {
		let ev;
		try {
			ev = JSON.parse(data);
		} catch {
			continue;
		}
		if (ev.error) throw new Error(`模型错误：${JSON.stringify(ev.error)}`);
		const u = ev.usageMetadata;
		if (u) {
			usage.input = u.promptTokenCount ?? usage.input;
			usage.output = (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0);
			usage.cacheRead = u.cachedContentTokenCount ?? 0;
		}
		const cand = ev.candidates?.[0];
		if (!cand) {
			if (ev.promptFeedback?.blockReason) throw new Error(`请求被拦截：${ev.promptFeedback.blockReason}`);
			continue;
		}
		if (cand.finishReason) finish = cand.finishReason;
		for (const part of cand.content?.parts || []) {
			if (part.functionCall) {
				const id = part.functionCall.id || `g${Date.now().toString(36)}${++seq}`;
				content.push({ type: "tool_call", id, rawName: part.functionCall.name, rawArgs: JSON.stringify(part.functionCall.args || {}), ...(part.thoughtSignature ? { signature: part.thoughtSignature } : {}) });
				yield { type: "tool_call", id, name: part.functionCall.name };
			} else if (typeof part.text === "string") {
				const type = part.thought ? "thinking" : "text";
				let b = last();
				if (!b || b.type !== type || b.signature) content.push((b = { type, text: "" }));
				b.text += part.text;
				if (part.thoughtSignature) b.signature = part.thoughtSignature;
				if (part.text) yield { type, delta: part.text };
			}
		}
	}

	// 思考文本只给界面看，不回传（Gemini 靠签名续上思考）；带签名的空文本保留用于回传
	const out = content.filter((b) => b.type !== "text" || b.text || b.signature);
	const hasCalls = out.some((b) => b.type === "tool_call");
	yield {
		type: "done",
		message: { role: "assistant", content: out },
		usage,
		stopReason: finish === "MAX_TOKENS" ? "length" : hasCalls ? "tool_calls" : "stop",
	};
}
