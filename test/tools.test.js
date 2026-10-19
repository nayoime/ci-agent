import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BUILTIN_TOOLS } from "../src/tools/index.js";
import { makeCodec, parseArgs } from "../src/tools/codec.js";
import { findCut } from "../src/agent/compaction.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ci-test-"));
const ctx = { cwd: tmp, settings: {} };
const T = Object.fromEntries(BUILTIN_TOOLS.map((t) => [t.name, t]));

test("write → read → edit（含 CRLF 保持）", async () => {
	await T.write.run({ path: "a.txt", content: "hello\r\nworld\r\n" }, ctx);
	const r = await T.read.run({ path: "a.txt" }, ctx);
	assert.match(r, /1\thello/);
	await T.edit.run({ path: "a.txt", edits: [{ oldText: "hello\nworld", newText: "你好\n世界" }] }, ctx);
	assert.equal(fs.readFileSync(path.join(tmp, "a.txt"), "utf8"), "你好\r\n世界\r\n");
});

test("edit 匹配多处时报错，replaceAll 生效", async () => {
	await T.write.run({ path: "b.txt", content: "x x x" }, ctx);
	await assert.rejects(T.edit.run({ path: "b.txt", edits: [{ oldText: "x", newText: "y" }] }, ctx), /3 处/);
	await T.edit.run({ path: "b.txt", edits: [{ oldText: "x", newText: "y", replaceAll: true }] }, ctx);
	assert.equal(fs.readFileSync(path.join(tmp, "b.txt"), "utf8"), "y y y");
});

test("bash / ls / glob / grep", async () => {
	const b = await T.bash.run({ command: "echo hi && exit 3" }, ctx);
	assert.match(b.content, /hi/);
	assert.match(b.content, /退出码：3/);
	assert.match(await T.ls.run({}, ctx), /a\.txt/);
	assert.match(await T.glob.run({ pattern: "*.txt" }, ctx), /b\.txt/);
	assert.match(await T.grep.run({ pattern: "世界" }, ctx), /a\.txt:2:/);
	assert.match(await T.grep.run({ pattern: "y", outputMode: "files" }, ctx), /b\.txt/);
});

test("codec：claude 风格编码与双向解码", () => {
	const c = makeCodec(BUILTIN_TOOLS, "claude");
	const names = c.schemas.map((s) => s.name);
	assert.ok(names.includes("Read") && names.includes("Task") && names.includes("Edit"));
	assert.ok(c.schemas.find((s) => s.name === "Read").parameters.properties.file_path);

	// Claude 风格调用 → 规范
	let d = c.decode("Edit", JSON.stringify({ file_path: "x", old_string: "a", new_string: "b" }));
	assert.deepEqual(d.args, { path: "x", edits: [{ oldText: "a", newText: "b", replaceAll: false }] });
	d = c.decode("Bash", { command: "ls", timeout: 30000 });
	assert.equal(d.args.timeout, 30);
	d = c.decode("Task", { description: "查", prompt: "看看" });
	assert.deepEqual(d.args.tasks, [{ description: "查", prompt: "看看" }]);

	// native 风格名在 claude 模式下也接受；别名
	assert.equal(c.decode("read", { path: "x" }).args.path, "x");
	assert.equal(c.decode("str_replace", { path: "x", old_string: "a", new_string: "b" }).name, "edit");
	assert.match(c.decode("nope", {}).error, /没有名为/);

	// 编码回放
	assert.deepEqual(c.encode("read", { path: "x" }), { name: "Read", args: { file_path: "x" } });
	assert.deepEqual(c.encode("bash", { command: "ls", timeout: 5 }), { name: "Bash", args: { command: "ls", timeout: 5000 } });
});

test("parseArgs 容错", () => {
	assert.deepEqual(parseArgs('```json\n{"a":1,}\n```'), { a: 1 });
	assert.deepEqual(parseArgs('{"a":{"b":1}'), { a: { b: 1 } });
	assert.deepEqual(parseArgs(JSON.stringify(JSON.stringify({ a: 1 }))), { a: 1 });
	assert.deepEqual(parseArgs(""), {});
	assert.throws(() => parseArgs("not json"));
});

test("compaction 切分点不拆散工具调用", () => {
	const big = "x".repeat(4000);
	const msgs = [
		{ role: "user", content: big },
		{ role: "assistant", content: [{ type: "tool_call", id: "1", name: "read", args: {} }] },
		{ role: "tool", id: "1", name: "read", content: big },
		{ role: "tool", id: "2", name: "read", content: big },
		{ role: "assistant", content: [{ type: "text", text: "ok" }] },
	];
	const cut = findCut(msgs, 1500);
	assert.notEqual(msgs[cut].role, "tool");
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test("思考档位映射与就近落档", async () => {
	const { thinkingParams, snapLevel } = await import("../src/protocol/index.js");
	const qwen = { maxOutput: 4096, provider: { protocol: "openai" }, noThinkBody: { chat_template_kwargs: { enable_thinking: false } } };
	assert.deepEqual(thinkingParams(qwen, "off").extraBody, { chat_template_kwargs: { enable_thinking: false } });
	assert.deepEqual(thinkingParams(qwen, "minimal").extraBody, { chat_template_kwargs: { enable_thinking: true } });
	const oa = { maxOutput: 4096, provider: { protocol: "openai" } };
	assert.deepEqual(thinkingParams(oa, "low").extraBody, { reasoning_effort: "low" });
	assert.equal(snapLevel(oa, "max"), "xhigh");
	const ds = { thinkStyle: "effort3", provider: { protocol: "openai" } };
	assert.equal(snapLevel(ds, "minimal"), "low");
	assert.equal(snapLevel(ds, "xhigh"), "high");
	const an = { maxOutput: 4096, provider: { protocol: "anthropic" } };
	const r = thinkingParams(an, "medium");
	assert.equal(r.extraBody.thinking.budget_tokens, 8192);
	assert.equal(r.maxTokens, 4096 + 8192);
	const custom = { thinkLevels: { high: { foo: { bar: 1 } } }, provider: { protocol: "openai" } };
	assert.equal(snapLevel(custom, "low"), "high");
	assert.deepEqual(thinkingParams(custom, "low", { extraBody: { foo: { x: 2 } } }).extraBody, { foo: { x: 2, bar: 1 } });
	assert.deepEqual(thinkingParams(custom, "off").extraBody, {});
});
