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
			// 假响应是空流：只关心请求体，同时验证空流按断流报错而不是当成正常结束
			await assert.rejects(async () => {
				for await (const _ of streamAnthropic(
					{ provider: { baseUrl: "https://example.test", apiKey: "test" }, model: "test", maxOutput: 100 },
					{ messages, codec: { encode: (name, args) => ({ name, args }) } },
				)) {}
			}, /响应流意外中断/);
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

test("上游卡住：空闲超时断开并报错（响应头前、流中途）；用户中止仍是中止", async () => {
	const http = await import("node:http");
	const { streamModel } = await import("../src/protocol/index.js");
	const srv = http.createServer((req, res) => {
		if (req.url.includes("mid")) {
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.write('event: message_start\ndata: {"type":"message_start","message":{"usage":{}}}\n\n');
		} // 否则连响应头都不发
	});
	await new Promise((r) => srv.listen(0, "127.0.0.1", r));
	const base = `http://127.0.0.1:${srv.address().port}`;
	const mk = (path) => ({ model: "m", maxOutput: 10, idleTimeout: 0.3, provider: { protocol: "anthropic", baseUrl: base + path, apiKey: "k" } });
	const run = (m, signal) => (async () => { for await (const _ of streamModel(m, { messages: [], codec: null, signal })) {} })();
	try {
		await assert.rejects(run(mk("/head")), /0\.3 秒没有返回任何数据/);
		await assert.rejects(run(mk("/mid")), /0\.3 秒没有返回任何数据/);
		const ac = new AbortController();
		setTimeout(() => ac.abort(), 100);
		await assert.rejects(run({ ...mk("/mid"), idleTimeout: 5 }, ac.signal), (e) => !/没有返回任何数据/.test(e.message));
	} finally {
		srv.closeAllConnections();
		srv.close();
	}
});
