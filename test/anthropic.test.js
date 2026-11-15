import test from "node:test";
import assert from "node:assert/strict";
import { streamAnthropic } from "../src/protocol/anthropic.js";

test("Anthropic 请求映射跨协议工具 ID，保留原生 ID 且不修改历史", async () => {
	const ids = ["call_example", "other/id", "toolu_native"];
	const messages = ids.flatMap((id) => [
		{ role: "assistant", content: [{ type: "tool_call", id, name: "read", args: { path: "a" } }] },
		{ role: "tool", id, content: "ok" },
	]);
	const original = structuredClone(messages);
	const oldFetch = globalThis.fetch;
	const bodies = [];
	globalThis.fetch = async (_url, options) => {
		bodies.push(JSON.parse(options.body));
		return new Response("", { status: 200 });
	};
	try {
		for (let i = 0; i < 2; i++) {
			for await (const _ of streamAnthropic(
				{ provider: { baseUrl: "https://example.test", apiKey: "test" }, model: "test", maxOutput: 100 },
				{ messages, codec: { encode: (name, args) => ({ name, args }) } },
			)) {}
		}
		const mapped = ids.map((_, i) => bodies[0].messages[i * 2].content[0].id);
		assert.equal(new Set(mapped).size, ids.length);
		for (let i = 0; i < ids.length; i++) {
			assert.match(mapped[i], /^toolu_[a-zA-Z0-9_-]+$/);
			assert.equal(bodies[0].messages[i * 2 + 1].content[0].tool_use_id, mapped[i]);
		}
		assert.equal(mapped[2], "toolu_native");
		assert.deepEqual(bodies[0], bodies[1]);
		assert.deepEqual(messages, original);
	} finally {
		globalThis.fetch = oldFetch;
	}
});
