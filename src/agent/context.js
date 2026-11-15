// 项目上下文：<项目>/.ci/ 隐藏目录，以及 AGENTS.md / CLAUDE.md
import fs from "node:fs";
import path from "node:path";

export function projectDir(cwd) {
	return path.join(cwd, ".ci");
}

/** 确保 .ci 目录存在 */
export function ensureProject(cwd) {
	const dir = projectDir(cwd);
	fs.mkdirSync(path.join(dir, "sessions"), { recursive: true });
	const gi = path.join(dir, ".gitignore");
	if (!fs.existsSync(gi)) fs.writeFileSync(gi, "sessions/\n");
	return dir;
}

export const DEFAULT_PROJECT_PROMPT = "你在 Ciallo Agent 中工作，你可以使用工具。";
export const projectPromptFile = (cwd) => path.join(projectDir(cwd), "prompt.md");

/** 项目提示词（拼在系统提示词最前面）。没设置过用默认值；设置成空就是不拼 */
export function loadProjectPrompt(cwd) {
	const f = projectPromptFile(cwd);
	return fs.existsSync(f) ? fs.readFileSync(f, "utf8") : DEFAULT_PROJECT_PROMPT;
}

/**
 * 项目开关与记忆库：<项目>/.ci/project.json
 * tools：是否提供工具（关掉就是纯对话），默认开
 * subagent：是否把子代理工具发给模型，默认开
 * memory：是否启用记忆库，默认关；memories：逐条记忆（字符串）
 */
const PROJECT_DEFAULTS = { tools: true, subagent: true, memory: false, memories: [] };
export const projectSettingsFile = (cwd) => path.join(projectDir(cwd), "project.json");

export function loadProjectSettings(cwd) {
	try {
		const s = JSON.parse(fs.readFileSync(projectSettingsFile(cwd), "utf8"));
		return {
			tools: s.tools !== false,
			subagent: s.subagent !== false,
			memory: s.memory === true,
			memories: Array.isArray(s.memories) ? s.memories.map(String).filter((x) => x.trim()) : [],
		};
	} catch {
		return { ...PROJECT_DEFAULTS, memories: [] };
	}
}

export function saveProjectSettings(cwd, patch) {
	ensureProject(cwd);
	const next = { ...loadProjectSettings(cwd), ...patch };
	next.tools = next.tools !== false;
	next.subagent = next.subagent !== false;
	next.memory = next.memory === true;
	next.memories = (next.memories || []).map((x) => String(x).trim()).filter(Boolean);
	fs.writeFileSync(projectSettingsFile(cwd), JSON.stringify(next, null, "\t"));
	return next;
}

/** 读取项目说明文件：项目根的 AGENTS.md / CLAUDE.md（取其一） */
export function loadProjectContext(cwd) {
	const files = [];
	for (const name of ["AGENTS.md", "CLAUDE.md"]) {
		const f = path.join(cwd, name);
		if (fs.existsSync(f)) {
			files.push({ path: f, content: fs.readFileSync(f, "utf8") });
			break; // 只取其一
		}
	}
	return files;
}
