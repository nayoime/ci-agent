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

