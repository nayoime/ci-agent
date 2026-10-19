// 代理循环：调用模型 → 执行工具 → 回填结果，直到模型不再调用工具
import { streamModel } from "../protocol/index.js";
import { makeCodec } from "../tools/codec.js";
import { findShell } from "../tools/util.js";
import { buildSystemPrompt, buildChatPrompt } from "./prompt.js";
import { compactMessages } from "./compaction.js";
import { estimateMessages, estimateMessage, estimateText } from "./tokens.js";
import { loadProjectContext, loadProjectPrompt, loadProjectSettings } from "./context.js";
import memoryTool from "../tools/memory.js";

class Semaphore {
	constructor(n) {
		this.n = n;
		this.waiters = [];
	}
	async acquire() {
		if (this.n > 0) return void this.n--;
		await new Promise((r) => this.waiters.push(r));
	}
	release() {
		const w = this.waiters.shift();
		if (w) w();
		else this.n++;
	}
}

let idSeq = 0;

export class Agent {
	/**
	 * @param {object} o
	 * @param {object} o.model     resolveModel() 的结果
	 * @param {string} o.cwd
	 * @param {import("../tools/index.js").ToolRegistry} o.registry
	 * @param {object} [o.settings]
	 * @param {(ev:object)=>void} [o.onEvent]
	 * @param {() => Array} [o.getSkills]    启用的技能（热更新）
	 * @param {object} [o.session]           持久化：{ append(entry) }
	 * @param {Agent} [o.parent]             子代理的父代理
	 */
	constructor(o) {
		this.id = o.id || `a${++idSeq}`;
		this.model = o.model;
		this.cwd = o.cwd;
		this.registry = o.registry;
		this.settings = o.settings || {};
		this.onEvent = o.onEvent || (() => {});
		this.getSkills = o.getSkills || (() => []);
		this.session = o.session || null;
		this.parent = o.parent || null;
		this.isSubagent = !!o.parent;
		this.messages = o.messages || [];
		this.loadedTools = new Set(o.loadedTools || []);
		this.semaphore = this.parent ? this.parent.semaphore : new Semaphore(this.model.maxParallel || 4);
		this.maxTurns = o.maxTurns ?? this.settings.maxTurns ?? 500;
		this.toolAborts = new Map();
		this.children = new Set();
		this.thinking = o.thinking || "off"; // 思考档位，见 protocol/index.js THINKING_LEVELS
		this.running = false;
		this.queue = []; // 运行中用户追加的消息
		this.pendingCompact = null;
		this.lastPromptTokens = 0; // 上次请求的真实 token 数
		this.countedUpTo = 0; // lastPromptTokens 覆盖到的消息下标
		this.recentCalls = [];
	}

	emit(ev) {
		try {
			this.onEvent(ev);
		} catch (e) {
			console.error("事件处理出错：", e);
		}
	}

	push(msg) {
		this.messages.push(msg);
		this.session?.append({ type: "message", message: msg });
	}

	/** 中止后可能留下没有结果的工具调用，补上占位结果，否则两种协议都会报错 */
	repairDangling() {
		const done = new Set(this.messages.filter((m) => m.role === "tool").map((m) => m.id));
		for (let i = this.messages.length - 1; i >= 0; i--) {
			const m = this.messages[i];
			if (m.role === "user") break;
			if (m.role !== "assistant") continue;
			for (const b of m.content) {
				if (b.type === "tool_call" && !done.has(b.id)) {
					this.push({ role: "tool", id: b.id, name: b.name, content: "（该调用未执行：用户中止了任务）", isError: true });
				}
			}
			break;
		}
	}

	/** 当前上下文 token 估算：上次真实值 + 之后新增消息的估算 */
	contextTokens() {
		if (!this.lastPromptTokens) return estimateMessages(this.messages) + 3000; // 3000 ≈ 系统提示 + 工具定义
		return this.lastPromptTokens + estimateMessages(this.messages.slice(this.countedUpTo));
	}

	/**
	 * 打开旧会话时用最后一条带统计的助手消息恢复真实 token 数，避免重开会话后计数跳变。
	 * from：最近一次重置（压缩、删除对话）后的消息下标，之前的统计已失效
	 */
	restoreCount(from) {
		for (let i = this.messages.length - 1; i >= from; i--) {
			const m = this.messages[i];
			if (m.role === "assistant" && m.stats?.input) {
				this.lastPromptTokens = m.stats.input + estimateMessage(m);
				this.countedUpTo = i + 1;
				return;
			}
		}
	}

	requestCompact(focus) {
		this.pendingCompact = focus ?? "";
	}

	/** 停止某个正在运行的工具调用（含子代理里的），找到返回 true */
	stopTool(callId) {
		const c = this.toolAborts.get(callId);
		if (c) return c.abort(), true;
		for (const ch of this.children) if (ch.stopTool(callId)) return true;
		return false;
	}

	abort() {
		this.controller?.abort();
	}

	/** 运行中追加用户消息（下一轮模型调用前送达） */
	steer(text) {
		this.queue.push(text);
	}

	async compact(focus, reason = "manual") {
		const before = this.contextTokens();
		this.emit({ type: "compact_start", reason });
		const r = await compactMessages(this.model, this.messages, { focus, signal: this.controller?.signal });
		if (!r) {
			this.emit({ type: "compact_end", skipped: true });
			return false;
		}
		this.messages = r.messages;
		this.lastPromptTokens = 0;
		this.countedUpTo = 0;
		this.session?.append({ type: "reset", messages: this.messages });
		this.emit({ type: "compact_end", reason, removed: r.removed, before, after: this.contextTokens(), summary: r.summary });
		return true;
	}

	/**
	 * 删除第 n 轮对话（按非摘要的用户消息计数，从 0 开始）：
	 * 该用户消息及其后的助手/工具消息，直到下一条用户消息。只改上下文，不回滚文件
	 */
	deleteTurn(n) {
		if (this.running) throw new Error("运行中不能删除对话");
		let seen = -1;
		let start = -1;
		for (let i = 0; i < this.messages.length; i++) {
			const m = this.messages[i];
			if (m.role === "user" && !m.summary && ++seen === n) {
				start = i;
				break;
			}
		}
		if (start < 0) return false;
		let end = start + 1;
		while (end < this.messages.length && this.messages[end].role !== "user") end++;
		this.messages.splice(start, end - start);
		this.lastPromptTokens = 0;
		this.countedUpTo = 0;
		this.session?.append({ type: "reset", messages: this.messages });
		return true;
	}

	buildRequest() {
		// 项目开关：tools 关掉就是纯对话；memory 开着就提供记忆工具并把记忆写进系统提示词
		const proj = this.isSubagent ? { tools: true, memory: false, memories: [] } : loadProjectSettings(this.cwd);
		let tools = proj.tools ? this.registry.activeTools(this, { subagent: this.isSubagent }) : [];
		if (proj.memory) tools = [...tools, memoryTool];
		const codec = makeCodec(tools, this.model.toolStyle);
		const memory = proj.memory ? proj.memories : null;
		if (!proj.tools) {
			const system = buildChatPrompt({ projectPrompt: loadProjectPrompt(this.cwd), memory, codec });
			return { tools, codec, system };
		}
		const system = buildSystemPrompt({
			memory,
			cwd: this.cwd,
			tools,
			codec,
			projectFiles: this.isSubagent ? [] : loadProjectContext(this.cwd),
			skills: this.isSubagent ? [] : this.getSkills(),
			subagent: this.isSubagent,
			shell: findShell(this.settings.shell),
			deferred: this.registry.deferredTools().filter((t) => !this.loadedTools.has(t.name)),
			projectPrompt: this.isSubagent ? "" : loadProjectPrompt(this.cwd),
		});
		return { tools, codec, system };
	}

	/** 解码模型消息中的原始工具调用 */
	decodeCalls(message, codec) {
		const calls = [];
		for (const b of message.content) {
			if (b.type !== "tool_call") continue;
			const d = codec.decode(b.rawName, b.rawArgs);
			b.name = d.name;
			b.args = d.args;
			delete b.rawName;
			delete b.rawArgs;
			calls.push({ block: b, ...d });
		}
		return calls;
	}

	/** 执行单个工具调用 */
	async execCall(call) {
		const { block, tool, error } = call;
		const label = tool?.label || block.name;
		// 每个调用单独一个中止信号：用户可以只停这一个命令，代理继续运行
		const own = new AbortController();
		this.toolAborts.set(block.id, own);
		const signal = AbortSignal.any([this.controller.signal, own.signal]);
		this.emit({ type: "tool_start", id: block.id, name: block.name, label, args: block.args, limit: tool?.limit?.(block.args), t0: Date.now() });
		let content;
		let isError = false;
		let details;
		if (error) {
			content = error;
			isError = true;
		} else {
			try {
				const r = await tool.run(block.args, {
					cwd: this.cwd,
					signal,
					settings: this.settings,
					agent: this,
					registry: this.registry,
					onUpdate: (chunk) => this.emit({ type: "tool_update", id: block.id, chunk }),
					spawnAgents: this.isSubagent ? null : (tasks) => this.spawnAgents(tasks, block.id),
				});
				if (typeof r === "string") content = r;
				else ({ content, isError = false, details } = r);
			} catch (e) {
				content = this.controller.signal.aborted ? "已被用户中止" : own.signal.aborted ? "用户手动停止了这个工具" : `错误：${e.message}`;
				isError = true;
			}
		}
		this.toolAborts.delete(block.id);
		// 死循环检测：连续 3 次完全相同的调用
		const sig = block.name + JSON.stringify(block.args);
		this.recentCalls.push(sig);
		if (this.recentCalls.length > 3) this.recentCalls.shift();
		if (this.recentCalls.length === 3 && this.recentCalls.every((s) => s === sig)) {
			content += "\n\n注意：你已连续 3 次用相同参数调用这个工具，结果不会变。请换一种方法，或直接回复用户。";
		}
		// 单个结果最多占上下文的 30%
		const cap = Math.floor(this.model.contextWindow * 0.3);
		if (estimateText(content) > cap) {
			const keep = Math.floor(content.length * (cap / estimateText(content)));
			content = content.slice(0, keep) + `\n\n（结果过长，已截断。请缩小范围，如使用 offset/limit 或更精确的搜索。）`;
		}
		this.emit({ type: "tool_end", id: block.id, name: block.name, label, content, isError, details });
		// details 随会话保存（如子代理过程），只给界面用，不发给模型
		return { role: "tool", id: block.id, name: block.name, content, isError, ...(details ? { details } : {}) };
	}

	async spawnAgents(tasks, parentCallId) {
		return Promise.all(
			tasks.map(async (task, index) => {
				await this.semaphore.acquire();
				const child = new Agent({
					id: `${this.id}.${index + 1}`,
					model: this.model,
					cwd: this.cwd,
					registry: this.registry,
					settings: this.settings,
					parent: this,
					loadedTools: this.loadedTools,
					maxTurns: Math.min(this.maxTurns, 100),
					thinking: task.thinking || "off", // 主代理没指定就不思考
					onEvent: (event) =>
						this.emit({ type: "subagent", parentCallId, index, agentId: `${this.id}.${index + 1}`, description: task.description, event }),
				});
				this.children.add(child);
				const onAbort = () => child.abort();
				this.controller.signal.addEventListener("abort", onAbort, { once: true });
				try {
					const text = await child.run(task.prompt);
					return { ok: true, text: text || "（子代理没有给出结论）", transcript: transcriptOf(child.messages) };
				} catch (e) {
					return { ok: false, error: e.message, transcript: transcriptOf(child.messages) };
				} finally {
					this.children.delete(child);
					this.controller.signal.removeEventListener("abort", onAbort);
					this.semaphore.release();
				}
			}),
		);
	}

	/** 调用一次模型，返回 { message, usage, stopReason } */
	async callModel(req) {
		let result;
		const t0 = Date.now();
		let tFirst = 0; // 首个输出 token 的时间，用于算生成速度
		for await (const ev of streamModel(this.model, {
			system: req.system,
			messages: this.messages,
			tools: req.codec.schemas,
			codec: req.codec,
			signal: this.controller.signal,
			thinking: this.thinking,
		})) {
			if (!tFirst && ev.type !== "done") tFirst = Date.now();
			if (ev.type === "done") result = ev;
			else if (ev.type === "tool_call") {
				const d = req.codec.decode(ev.name, "{}");
				this.emit({ type: "tool_call_streaming", id: ev.id, name: d.tool?.name || ev.name, label: d.tool?.label || ev.name });
			} else this.emit(ev);
		}
		if (result) {
			// 统计挂在消息上，随会话保存；协议转换时不会发给模型
			const t1 = Date.now();
			const genMs = tFirst ? t1 - tFirst : 0;
			const u = result.usage || {};
			result.message.stats = {
				input: u.input || 0,
				output: u.output || 0,
				cacheRead: u.cacheRead || 0,
				ttft: tFirst ? tFirst - t0 : 0,
				ms: t1 - t0,
				tps: genMs > 50 && u.output ? Math.round((u.output / genMs) * 10000) / 10 : 0,
			};
		}
		return result;
	}

	/**
	 * 处理一条用户输入，返回最终回复文本
	 * @param {string | Array | null} input 文本或内容块；null 表示不追加新消息，直接用现有上下文继续（断联重试）
	 */
	async run(input) {
		if (this.running) throw new Error("代理正在运行中");
		this.running = true;
		this.controller = new AbortController();
		this.recentCalls = [];
		this.repairDangling();
		if (input != null) this.push({ role: "user", content: input });
		let finalText = "";
		let overflowRetried = false;

		try {
			for (let turn = 0; turn < this.maxTurns; turn++) {
				if (this.controller.signal.aborted) throw Object.assign(new Error("已中止"), { name: "AbortError" });

				// 自动压缩 / 工具请求的压缩
				if (this.pendingCompact !== null || this.contextTokens() > this.model.compactAt) {
					const focus = this.pendingCompact;
					this.pendingCompact = null;
					await this.compact(focus || "", focus !== null ? "tool" : "auto");
				}

				const req = this.buildRequest();
				this.emit({ type: "turn_start", turn });
				let res;
				try {
					res = await this.callModel(req);
				} catch (e) {
					if (e.code === "context_overflow" && !overflowRetried) {
						overflowRetried = true;
						this.emit({ type: "notice", text: "上下文超出模型上限，正在压缩后重试…" });
						if (await this.compact("", "overflow")) {
							turn--;
							continue;
						}
					}
					throw e;
				}
				if (!res) throw new Error("模型没有返回完整响应");

				const calls = this.decodeCalls(res.message, req.codec);
				this.push(res.message);
				// 不直接加 output：output 含思考 token，而思考内容下一轮大多不回传，会让计数忽长忽短
				this.lastPromptTokens = res.usage.input + estimateMessage(res.message);
				this.countedUpTo = this.messages.length;
				this.emit({
					type: "assistant",
					message: res.message,
					usage: res.usage,
					stopReason: res.stopReason,
					contextTokens: this.contextTokens(),
					contextWindow: this.model.contextWindow,
				});

				const text = res.message.content.filter((b) => b.type === "text").map((b) => b.text).join("");
				if (text) finalText = text;

				if (!calls.length) {
					if (res.stopReason === "length") this.emit({ type: "notice", text: "回复达到单次最大输出长度，已截断。" });
					if (this.queue.length) {
						this.push({ role: "user", content: this.queue.splice(0).join("\n\n") });
						continue;
					}
					return finalText;
				}

				const parallel = calls.every((c) => c.tool?.readOnly || c.tool?.parallelSafe || c.error);
				const results = parallel
					? await Promise.all(calls.map((c) => this.execCall(c)))
					: await calls.reduce(async (acc, c) => [...(await acc), await this.execCall(c)], Promise.resolve([]));
				for (const r of results) this.push(r);

				if (this.queue.length) this.push({ role: "user", content: this.queue.splice(0).join("\n\n") });
			}
			this.emit({ type: "notice", text: `已达到最大轮数 ${this.maxTurns}，自动停止。` });
			return finalText;
		} finally {
			this.running = false;
		}
	}
}

/** 子代理过程的精简记录（思考、工具调用、文字、统计），存进会话供界面回放 */
const clip = (t, n) => (t && t.length > n ? t.slice(0, n) + "…" : t || "");
export function transcriptOf(messages) {
	const log = [];
	const tools = new Map();
	let up = 0, down = 0, tps = 0;
	for (const m of messages) {
		if (m.role === "assistant") {
			for (const b of m.content) {
				if (b.type === "thinking" && b.text?.trim()) log.push({ k: "think", t: clip(b.text.trim(), 3000) });
				else if (b.type === "text" && b.text?.trim()) log.push({ k: "text", t: clip(b.text, 6000) });
				else if (b.type === "tool_call") tools.set(b.id, log.push({ k: "tool", name: b.name, args: b.args, ok: true }) - 1);
			}
			if (m.stats) (up += m.stats.input), (down += m.stats.output), m.stats.tps && (tps = m.stats.tps);
		} else if (m.role === "tool" && tools.has(m.id)) {
			const t = log[tools.get(m.id)];
			t.ok = !m.isError;
			t.out = clip(m.content || "", 2000);
		}
	}
	return { log, up, down, tps };
}
