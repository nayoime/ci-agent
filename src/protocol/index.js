// 协议入口：按模型配置中写明的 protocol 分发
import { streamOpenAI } from "./openai.js";
import { streamAnthropic } from "./anthropic.js";
import { streamGemini } from "./gemini.js";

/**
 * 统一流式接口。产出事件：
 *   { type: "text" | "thinking", delta }
 *   { type: "tool_call", id, name }           工具调用开始（原始名）
 *   { type: "done", message, usage, stopReason }
 * message.content 中工具调用为 { type:"tool_call", id, rawName, rawArgs }，由上层解码。
 */
/** 空闲超时（秒）：连接开着却长时间不发任何数据（上游卡住）时断开。模型配置 idleTimeout 可改，0 关闭 */
export const DEFAULT_IDLE_TIMEOUT = 300;

export async function* streamModel(model, req) {
	if (req.thinking) req = { ...req, ...thinkingParams(model, req.thinking, req) };
	const proto = model.provider.protocol;
	const secs = model.idleTimeout ?? DEFAULT_IDLE_TIMEOUT;
	if (!secs) return yield* dispatch(proto, model, req);
	// 看门狗：等响应头、每收到一块数据（readSSE 调 touch）都重新计时
	const wd = new AbortController();
	let timer;
	const touch = () => {
		clearTimeout(timer);
		timer = setTimeout(() => wd.abort(), secs * 1000);
	};
	const signal = AbortSignal.any([req.signal, wd.signal].filter(Boolean));
	signal.touch = touch;
	touch();
	try {
		yield* dispatch(proto, model, { ...req, signal });
	} catch (e) {
		if (wd.signal.aborted && !req.signal?.aborted) throw new Error(`上游 ${secs} 秒没有返回任何数据，已断开（可能是服务端卡住）。可空白发送重试`);
		throw e;
	} finally {
		clearTimeout(timer);
	}
}

function dispatch(proto, model, req) {
	return proto === "anthropic" ? streamAnthropic(model, req) : proto === "gemini" ? streamGemini(model, req) : streamOpenAI(model, req);
}

/** 统一的思考档位（对话里选这个；各模型按自己的映射落到请求参数） */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

const on = (body) => body; // 仅为可读
/** 预设映射：档位 → 合并进请求体的参数。只列模型支持的档位 */
export const THINK_PRESETS = {
	// 只有开关：Qwen3（llama.cpp / vLLM）
	qwen: { off: { chat_template_kwargs: { enable_thinking: false } }, high: on({ chat_template_kwargs: { enable_thinking: true } }) },
	// 只有开关：DeepSeek V3.1+、Kimi、GLM 等 thinking.type 风格
	toggle: { off: { thinking: { type: "disabled" } }, high: { thinking: { type: "enabled" } } },
	// OpenAI reasoning_effort
	effort: { off: {}, minimal: { reasoning_effort: "minimal" }, low: { reasoning_effort: "low" }, medium: { reasoning_effort: "medium" }, high: { reasoning_effort: "high" }, xhigh: { reasoning_effort: "xhigh" } },
	// 三档：low/medium/high（DeepSeek、Grok、Gemini OpenAI 兼容等）
	effort3: { off: {}, low: { reasoning_effort: "low" }, medium: { reasoning_effort: "medium" }, high: { reasoning_effort: "high" } },
	// Anthropic budget_tokens
	budget: Object.fromEntries([["off", 0], ["minimal", 1024], ["low", 2048], ["medium", 8192], ["high", 16384], ["xhigh", 32768], ["max", 63999]].map(([k, n]) => [k, n ? { thinking: { type: "enabled", budget_tokens: n } } : {}])),
	none: { off: {} },
};

/**
 * 官方接口的固定映射（设置界面单独列出，其他接口用“自定义”）。
 * 档位最多 6 档 + 关；这里只列官方支持的
 */
export const OFFICIAL_THINK = {
	openai: {
		label: "OpenAI 官方",
		map: { off: { reasoning_effort: "none" }, minimal: { reasoning_effort: "minimal" }, low: { reasoning_effort: "low" }, medium: { reasoning_effort: "medium" }, high: { reasoning_effort: "high" }, xhigh: { reasoning_effort: "xhigh" } },
	},
	claude: { label: "Claude 官方", map: THINK_PRESETS.budget },
	google: {
		// Gemini 原生协议：thinkingConfig（关 = 预算 0；其余用 thinkingLevel）
		label: "Google 官方",
		map: Object.fromEntries(
			[["off", null], ["minimal", "minimal"], ["low", "low"], ["medium", "medium"], ["high", "high"]].map(([k, v]) => [
				k,
				{ generationConfig: { thinkingConfig: v ? { thinkingLevel: v } : { thinkingBudget: 0 } } },
			]),
		),
	},
	deepseek: {
		label: "DeepSeek 官方",
		map: { off: { thinking: { type: "disabled" } }, high: { reasoning_effort: "high" }, max: { reasoning_effort: "max" } },
	},
};

/** 模型的档位映射：自定义 thinkLevels 优先，否则用预设（未写时按协议推断） */
export function thinkMap(model) {
	if (OFFICIAL_THINK[model.thinkStyle]) return OFFICIAL_THINK[model.thinkStyle].map;
	// 档位名列表（设置界面勾选的结果）：每档的请求参数自动推断，用户不用关心模型细节
	if (Array.isArray(model.thinkLevels)) {
		const base = THINK_PRESETS[inferStyle(model)] || {};
		const anthropic = model.provider?.protocol === "anthropic";
		const m = {};
		for (const l of THINKING_LEVELS) {
			if (!model.thinkLevels.includes(l)) continue;
			// 只有开关的风格（qwen / toggle）：任何非关档位都等于“开”
			const onlyToggle = base.high && Object.keys(base).length === 2;
			m[l] = base[l] ?? (l === "off" ? {} : onlyToggle ? base.high : anthropic ? THINK_PRESETS.budget[l] : { reasoning_effort: l });
		}
		return Object.keys(m).length ? m : { off: {} };
	}
	if (model.thinkLevels && typeof model.thinkLevels === "object") {
		// 写 "off": null 表示不能关（如部分 Claude），关会就近落到最低档
		const m = { off: {}, ...model.thinkLevels };
		for (const k of Object.keys(m)) if (m[k] === null) delete m[k];
		return m;
	}
	const style = inferStyle(model);
	return OFFICIAL_THINK[style]?.map || THINK_PRESETS[style] || THINK_PRESETS.none;
}

/** 预设风格：写了 thinkStyle 用它，否则按协议推断 */
function inferStyle(model) {
	if (model.thinkStyle) return model.thinkStyle;
	return JSON.stringify(model.noThinkBody || {}).includes("enable_thinking") ? "qwen" : model.provider?.protocol === "anthropic" ? "budget" : model.provider?.protocol === "gemini" ? "google" : "effort";
}

/** 把请求的档位落到模型实际支持的档位：开 → 不会落到关；否则取最近的，平局取低 */
export function snapLevel(model, level) {
	const have = Object.keys(thinkMap(model)).sort((a, b) => THINKING_LEVELS.indexOf(a) - THINKING_LEVELS.indexOf(b));
	if (have.includes(level)) return level;
	const want = Math.max(0, THINKING_LEVELS.indexOf(level));
	const pool = want === 0 ? have : have.filter((l) => l !== "off");
	if (!pool.length) return have[0] || "off";
	return pool.reduce((best, l) => (Math.abs(THINKING_LEVELS.indexOf(l) - want) < Math.abs(THINKING_LEVELS.indexOf(best) - want) ? l : best));
}

const merge = (a, b) => {
	const o = { ...a };
	for (const [k, v] of Object.entries(b)) o[k] = v && typeof v === "object" && !Array.isArray(v) && typeof o[k] === "object" ? merge(o[k], v) : v;
	return o;
};

/** 把思考档位转换成请求参数 */
export function thinkingParams(model, level, req = {}) {
	const body = thinkMap(model)[snapLevel(model, level)] || {};
	let maxTokens = req.maxTokens;
	// Anthropic 要求 max_tokens 大于思考预算
	const budget = body.thinking?.budget_tokens;
	if (budget) maxTokens = (maxTokens ?? model.maxOutput) + budget;
	return { extraBody: merge(req.extraBody || {}, body), maxTokens, noThinking: true };
}
