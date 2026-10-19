#!/usr/bin/env node
// 命令行入口（调试用）：node src/cli.js [-m 模型] [-C 目录] [-p "单次任务"]
import readline from "node:readline";
import { loadConfig, resolveModel } from "./config.js";
import { Agent } from "./agent/agent.js";
import { Session } from "./agent/session.js";
import { ToolRegistry } from "./tools/index.js";

const argv = process.argv.slice(2);
const opt = (k) => {
	const i = argv.indexOf(k);
	return i >= 0 ? argv[i + 1] : undefined;
};
const cfg = loadConfig();
const model = resolveModel(cfg, opt("-m"));
const cwd = opt("-C") || process.cwd();
const once = opt("-p");

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const short = (s, n = 120) => (s.length > n ? s.slice(0, n) + "…" : s);

let thinking = false;
function onEvent(ev, prefix = "") {
	switch (ev.type) {
		case "thinking":
			if (!thinking) process.stdout.write(dim(`\n${prefix}💭 `));
			thinking = true;
			process.stdout.write(dim(ev.delta));
			break;
		case "text":
			if (thinking) process.stdout.write("\n\n");
			thinking = false;
			process.stdout.write(ev.delta);
			break;
		case "tool_start":
			thinking = false;
			process.stdout.write(cyan(`\n${prefix}▶ ${ev.label} `) + dim(short(JSON.stringify(ev.args))) + "\n");
			break;
		case "tool_end":
			process.stdout.write((ev.isError ? red : dim)(`${prefix}  ${short(ev.content.replace(/\s+/g, " "), 200)}\n`));
			break;
		case "assistant":
			process.stdout.write(dim(`\n${prefix}[上下文 ${ev.contextTokens}/${ev.contextWindow}]\n`));
			break;
		case "compact_start":
			process.stdout.write(cyan(`\n${prefix}⟳ 压缩上下文（${ev.reason}）…\n`));
			break;
		case "compact_end":
			if (!ev.skipped) process.stdout.write(cyan(`${prefix}  ${ev.before} → ${ev.after} token，摘要了 ${ev.removed} 条消息\n`));
			break;
		case "notice":
			process.stdout.write(cyan(`\n${prefix}ℹ ${ev.text}\n`));
			break;
		case "subagent":
			if (["tool_start", "tool_end", "notice"].includes(ev.event.type)) onEvent(ev.event, `${prefix}  [子代理${ev.index + 1}] `);
			break;
	}
}

const session = new Session(cwd);
session.append({ type: "meta", meta: { model: model.id, cwd } });
const agent = new Agent({ model, cwd, registry: new ToolRegistry(), settings: cfg.settings, onEvent, session });

console.log(dim(`ci · ${model.name || model.id} · ${model.provider.protocol} · ${cwd}`));

if (once) {
	try {
		await agent.run(once);
		console.log();
	} catch (e) {
		console.error(red(`\n错误：${e.message}`));
		process.exitCode = 1;
	}
} else {
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	process.on("SIGINT", () => (agent.running ? agent.abort() : process.exit(0)));
	const ask = () =>
		rl.question("\n> ", async (line) => {
			line = line.trim();
			if (line === "/exit") return rl.close();
			if (line === "/compact") await agent.compact("", "manual").catch((e) => console.error(red(e.message)));
			else if (line) await agent.run(line).catch((e) => console.error(red(`\n错误：${e.message}`)));
			ask();
		});
	ask();
}
