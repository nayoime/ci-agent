// Anthropic Messages 适配器
import { createHash } from "node:crypto";
import { readSSE, httpError } from "./sse.js";

function toWire(messages, codec) {
	const out = [];
	// 跨协议历史的调用 ID 也要转换；调用和结果使用相同映射，不改持久化消息。
	const toolId = (id) => typeof id === "string" && id.startsWith("toolu_")
		? id
		: `toolu_${createHash("sha256").update(String(id)).digest("hex")}`;
	const push = (role, blocks) => {
		const last = out[out.length - 1];
		if (last && last.role === role) last.content.push(...blocks); // 合并同角色相邻消息
		else out.push({ role, content: blocks });
	};
	for (const m of messages) {
		if (m.role === "user") {
			const blocks =
				typeof m.content === "string"
					? [{ type: "text", text: m.content }]
					: m.content.map((b) =>
							b.type === "image"
								? { type: "image", source: { type: "base64", media_type: b.mime, data: b.data } }
								: { type: "text", text: b.text },
						);
			push("user", blocks);
		} else if (m.role === "assistant") {
			const blocks = [];
			for (const b of m.content) {
				// 思考块必须带签名才能回传（官方 API 要求）；无签名的丢弃
				if (b.type === "thinking" && b.signature) blocks.push({ type: "thinking", thinking: b.text, signature: b.signature });
				else if (b.type === "text" && b.text) blocks.push({ type: "text", text: b.text });
				else if (b.type === "tool_call") {
					const w = codec.encode(b.name, b.args);
					blocks.push({ type: "tool_use", id: toolId(b.id), name: w.name, input: w.args });
				}
			}
			if (blocks.length) push("assistant", blocks);
		} else if (m.role === "tool") {
			push("user", [{ type: "tool_result", tool_use_id: toolId(m.id), content: m.content, is_error: !!m.isError }]);
		}
	}
	// 历史缓存断点（system、tools 各占一个，上限 4 个）：最后一条用户消息让下一轮复用；
	// 上一条用户消息正是上一轮请求的结尾，打上后精确命中上一轮写入的缓存（一轮工具结果很多时也不会超出回溯范围）
	let marks = 0;
	for (let i = out.length - 1; i >= 0 && marks < 2; i--) {
		if (out[i].role !== "user") continue;
		const blocks = out[i].content;
		blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], cache_control: { type: "ephemeral" } };
		marks++;
	}
	return out;
}

export async function* streamAnthropic(model, { system, messages, tools, codec, signal, maxTokens, extraBody, noThinking }) {
	const p = model.provider;
	const body = {
		model: model.model,
		max_tokens: maxTokens ?? model.maxOutput,
		// 系统提示词为空（纯对话且没写项目提示词）时不发，空文本块会被拒绝
		...(system ? { system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }] } : {}),
		messages: toWire(messages, codec),
		stream: true,
		...(model.extraBody || {}),
		...(extraBody || {}),
	};
	if (tools?.length) {
		body.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
		body.tools[body.tools.length - 1].cache_control = { type: "ephemeral" };
	}

	const base = p.baseUrl.replace(/\/$/, "");
	const url = base.endsWith("/v1") ? base + "/messages" : base + "/v1/messages";
	const auth = p.authStyle === "bearer" ? { Authorization: `Bearer ${p.apiKey}` } : { "x-api-key": p.apiKey };
	const res = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json", "anthropic-version": "2023-06-01", ...auth, ...(p.headers || {}) },
		body: JSON.stringify(body),
		signal,
	});
	if (!res.ok) throw await httpError(res);

	const blocks = []; // 按 index
	let stopReason = "stop";
	const usage = { input: 0, output: 0, cacheRead: 0 };

	for await (const { data } of readSSE(res, signal)) {
		let ev;
		try {
			ev = JSON.parse(data);
		} catch {
			continue;
		}
		switch (ev.type) {
			case "message_start": {
				const u = ev.message?.usage || {};
				usage.input = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
				usage.cacheRead = u.cache_read_input_tokens ?? 0;
				usage.output = u.output_tokens ?? 0;
				break;
			}
			case "content_block_start": {
				const cb = ev.content_block;
				if (cb.type === "text") blocks[ev.index] = { type: "text", text: cb.text || "" };
				else if (cb.type === "thinking") blocks[ev.index] = { type: "thinking", text: cb.thinking || "", signature: cb.signature || "" };
				else if (cb.type === "redacted_thinking") blocks[ev.index] = { type: "redacted", data: cb.data };
				else if (cb.type === "tool_use") {
					blocks[ev.index] = { type: "tool_call", id: cb.id, rawName: cb.name, rawArgs: "" };
					yield { type: "tool_call", id: cb.id, name: cb.name };
				}
				break;
			}
			case "content_block_delta": {
				const b = blocks[ev.index];
				const d = ev.delta;
				if (!b) break;
				if (d.type === "text_delta") {
					b.text += d.text;
					yield { type: "text", delta: d.text };
				} else if (d.type === "thinking_delta") {
					b.text += d.thinking;
					yield { type: "thinking", delta: d.thinking };
				} else if (d.type === "signature_delta") b.signature += d.signature;
				else if (d.type === "input_json_delta") b.rawArgs += d.partial_json;
				break;
			}
			case "message_delta":
				if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
				if (ev.usage?.output_tokens != null) usage.output = ev.usage.output_tokens;
				break;
			case "error":
				throw new Error(`模型错误：${JSON.stringify(ev.error)}`);
		}
	}

	const content = blocks.filter((b) => b && b.type !== "redacted" && !(b.type === "text" && !b.text));
	const hasCalls = content.some((b) => b.type === "tool_call");
	yield {
		type: "done",
		message: { role: "assistant", content },
		usage,
		stopReason: stopReason === "max_tokens" ? "length" : hasCalls ? "tool_calls" : "stop",
	};
}
