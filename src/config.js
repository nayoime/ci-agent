// 配置：data/config.json（API Key 明文存储，已在 .gitignore 中忽略）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DATA_DIR = path.join(ROOT, "data");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");

const DEFAULT_CONFIG = {
	providers: {
		local: {
			name: "本地 llama.cpp（OpenAI 协议）",
			protocol: "openai",
			baseUrl: "http://127.0.0.1:8686/v1",
			apiKey: "sk-local-qwen",
		},
		"local-anthropic": {
			name: "本地 llama.cpp（Anthropic 协议）",
			protocol: "anthropic",
			baseUrl: "http://127.0.0.1:8686",
			apiKey: "sk-local-qwen",
		},
	},
	models: {
		"qwen3-8b": {
			name: "Qwen3 8B（本地）",
			provider: "local",
			model: "qwen3-8b",
			contextWindow: 32768, // 模型/服务端上下文上限
			maxOutput: 4096, // 单次最大输出
			compactAt: 24000, // 超过该 token 数自动压缩
			keepRecent: 8000, // 压缩时保留最近多少 token 不摘要
			toolStyle: "native", // native | claude：工具名/参数以哪种风格发给模型
			maxParallel: 4, // 子代理最大并发
			noThinkBody: { chat_template_kwargs: { enable_thinking: false } }, // 摘要等辅助请求关闭思考（llama.cpp/Qwen 专用）
		},
		"qwen3-8b-anthropic": {
			name: "Qwen3 8B（本地 · Anthropic 协议）",
			provider: "local-anthropic",
			model: "qwen3-8b",
			contextWindow: 32768,
			maxOutput: 4096,
			compactAt: 24000,
			keepRecent: 8000,
			toolStyle: "claude",
			maxParallel: 4,
			noThinkBody: { chat_template_kwargs: { enable_thinking: false } },
		},
	},
	defaultModel: "qwen3-8b",
	settings: {
		shell: null, // 自定义 shell 路径；null 自动查找 Git Bash
		maxTurns: 500, // 单次任务最多轮数
	},
};

export function loadConfig() {
	if (!fs.existsSync(CONFIG_FILE)) {
		fs.mkdirSync(DATA_DIR, { recursive: true });
		fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, "\t"));
	}
	const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
	cfg.settings = { ...DEFAULT_CONFIG.settings, ...cfg.settings };
	return cfg;
}

export function saveConfig(cfg) {
	fs.mkdirSync(DATA_DIR, { recursive: true });
	fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, "\t"));
	saved?.();
}
let saved = null;
/** 服务端注册：自己保存后刷新记录的修改时间，避免把自己的保存当成外部修改 */
export const onConfigSaved = (fn) => (saved = fn);

/** 解析模型配置，合并默认值并附带 provider */
export function resolveModel(cfg, modelId) {
	const id = modelId || cfg.defaultModel;
	const m = cfg.models[id];
	if (!m) throw new Error(`未知模型：${id}（可选：${Object.keys(cfg.models).join("、")}）`);
	const provider = cfg.providers[m.provider];
	if (!provider) throw new Error(`模型 ${id} 引用了不存在的 provider：${m.provider}`);
	if (!["openai", "anthropic", "gemini"].includes(provider.protocol)) {
		throw new Error(`provider ${m.provider} 的 protocol 必须是 openai、anthropic 或 gemini`);
	}
	const contextWindow = m.contextWindow ?? 32768;
	return {
		id,
		maxOutput: 4096,
		toolStyle: "native",
		maxParallel: 4,
		...m,
		contextWindow,
		compactAt: m.compactAt ?? Math.floor(contextWindow * 0.75),
		keepRecent: m.keepRecent ?? Math.floor(contextWindow * 0.25),
		provider: { id: m.provider, ...provider },
	};
}
