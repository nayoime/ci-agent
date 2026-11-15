import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent } from "../src/agent/agent.js";

const mk = (messages) => new Agent({ model: { contextWindow: 1000, maxParallel: 1 }, cwd: ".", registry: {}, messages });

const sample = () => [
	{ role: "user", summary: true, content: "<历史摘要>…</历史摘要>" },
	{ role: "user", content: "a" },
	{ role: "assistant", content: [{ type: "tool_call", id: "1", name: "read" }] },
	{ role: "tool", id: "1", content: "x" },
	{ role: "assistant", content: [{ type: "text", text: "ok" }] },
	{ role: "user", content: "b" },
	{ role: "assistant", content: [{ type: "text", text: "ok2" }] },
];

test("deleteTurn 删除一轮（跳过摘要，含工具结果）", () => {
	const a = mk(sample());
	assert.equal(a.deleteTurn(0), true);
	assert.deepEqual(a.messages.map((m) => m.role), ["user", "user", "assistant"]);
	assert.equal(a.messages[1].content, "b");
});

test("deleteTurn 最后一轮 / 越界", () => {
	const a = mk(sample());
	assert.equal(a.deleteTurn(1), true);
	assert.equal(a.messages.length, 5);
	assert.equal(a.deleteTurn(5), false);
});


import { mergeSubagentCalls } from "../src/agent/agent.js";
test("同一轮多个 Task 合并成一次多任务调用", async () => {
	const assert = (await import("node:assert/strict")).default;
	const mk = (id, prompt) => ({ name: "subagent", args: { tasks: [{ prompt }] }, block: { id, name: "subagent" } });
	const other = { name: "read", args: {}, block: { id: "r" } };
	const { calls, merged } = mergeSubagentCalls([mk("a", "1"), other, mk("b", "2")]);
	assert.equal(calls.length, 2);
	assert.deepEqual(calls[0].runArgs.tasks.map((t) => t.prompt), ["1", "2"]);
	assert.equal(merged[0].mergedInto, "a");
	assert.deepEqual(calls[0].args.tasks.length, 1); // 原调用参数不变，回放给模型仍是单个 Task
	assert.equal(mergeSubagentCalls([mk("x", "1")]).merged.length, 0);
});

test("停止任务后手动压缩不复用已中止的信号", async () => {
	const original = globalThis.fetch;
	globalThis.fetch = async (_url, options) => {
		assert.equal(options.signal, undefined);
		return new Response('data: {"choices":[{"delta":{"content":"压缩摘要"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "Content-Type": "text/event-stream" } });
	};
	try {
		const agent = new Agent({
			model: { model: "test", contextWindow: 10000, keepRecent: 10, maxOutput: 100, provider: { protocol: "openai", baseUrl: "http://test", apiKey: "test" } },
			cwd: ".", registry: {},
			messages: [{ role: "user", content: "旧对话".repeat(100) }, { role: "assistant", content: [{ type: "text", text: "最近的回答".repeat(20) }] }],
		});
		agent.controller = new AbortController();
		agent.controller.abort();
		assert.equal(await agent.compact(), true);
		assert.equal(agent.messages[0].summary, true);
	} finally {
		globalThis.fetch = original;
	}
});
