// OpenAI Chat Completions 适配器
import { readSSE, httpError } from "./sse.js";

/** 内部消息 → OpenAI messages */
function toWire(system, messages, codec) {
	const out = system ? [{ role: "system", content: system }] : [];
	for (const m of messages) {
		if (m.role === "user") {
			if (typeof m.content === "string") out.push({ role: "user", content: m.content });
			else
				out.push({
					role: "user",
					content: m.content.map((b) =>
						b.type === "image"
							? { type: "image_url", image_url: { url: `data:${b.mime};base64,${b.data}` } }
							: { type: "text", text: b.text },
					),
				});
		} else if (m.role === "assistant") {
			const text = m.content.filter((b) => b.type === "text").map((b) => b.text).join("");
			const calls = m.content.filter((b) => b.type === "tool_call");
			const msg = { role: "assistant", content: text || null };
			if (calls.length) {
				msg.tool_calls = calls.map((c) => {
					const w = codec.encode(c.name, c.args);
					return { id: c.id, type: "function", function: { name: w.name, arguments: JSON.stringify(w.args) } };
				});
			}
			out.push(msg);
		} else if (m.role === "tool") {
			out.push({ role: "tool", tool_call_id: m.id, content: m.content });
		}
	}
	return out;
}

export async function* streamOpenAI(model, { system, messages, tools, codec, signal, maxTokens, extraBody }) {
	const p = model.provider;
	const body = {
		model: model.model,
		messages: toWire(system, messages, codec),
		stream: true,
		stream_options: { include_usage: true },
		max_tokens: maxTokens ?? model.maxOutput,
		...(model.extraBody || {}),
		...(extraBody || {}),
	};
	if (tools?.length) {
		body.tools = tools.map((t) => ({
			type: "function",
			function: { name: t.name, description: t.description, parameters: t.parameters },
		}));
	}

	const res = await fetch(p.baseUrl.replace(/\/$/, "") + "/chat/completions", {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${p.apiKey}`, ...(p.headers || {}) },
		body: JSON.stringify(body),
		signal,
	});
	if (!res.ok) throw await httpError(res);

	let text = "";
	let thinking = "";
	const calls = []; // 按 index 累积
	let stopReason = "stop";
	let usage = { input: 0, output: 0, cacheRead: 0 };

	for await (const { data } of readSSE(res, signal)) {
		if (data === "[DONE]") break;
		let chunk;
		try {
			chunk = JSON.parse(data);
		} catch {
			continue;
		}
		if (chunk.error) throw new Error(`模型错误：${JSON.stringify(chunk.error)}`);
		if (chunk.usage) {
			usage = {
				input: chunk.usage.prompt_tokens ?? 0,
				output: chunk.usage.completion_tokens ?? 0,
				cacheRead: chunk.usage.prompt_tokens_details?.cached_tokens ?? 0,
			};
		}
		const choice = chunk.choices?.[0];
		if (!choice) continue;
		const d = choice.delta || {};
		const r = d.reasoning_content ?? d.reasoning;
		if (r) {
			thinking += r;
			yield { type: "thinking", delta: r };
		}
		if (d.content) {
			text += d.content;
			yield { type: "text", delta: d.content };
		}
		for (const tc of d.tool_calls || []) {
			const i = tc.index ?? calls.length;
			if (!calls[i]) {
				calls[i] = { id: tc.id || `call_${Date.now()}_${i}`, name: "", args: "" };
			}
			if (tc.id) calls[i].id = tc.id;
			if (tc.function?.name) {
				calls[i].name += tc.function.name;
				yield { type: "tool_call", id: calls[i].id, name: calls[i].name };
			}
			if (tc.function?.arguments) calls[i].args += tc.function.arguments;
		}
		if (choice.finish_reason) stopReason = choice.finish_reason;
	}

	const content = [];
	if (thinking) content.push({ type: "thinking", text: thinking });
	if (text) content.push({ type: "text", text });
	for (const c of calls.filter(Boolean)) content.push({ type: "tool_call", id: c.id, rawName: c.name, rawArgs: c.args });
	yield {
		type: "done",
		message: { role: "assistant", content },
		usage,
		stopReason: stopReason === "length" ? "length" : calls.length ? "tool_calls" : "stop",
	};
}
