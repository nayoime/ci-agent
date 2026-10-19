// 工具注册表：内置工具 + 外部（MCP）延迟加载工具
import read from "./read.js";
import write from "./write.js";
import edit from "./edit.js";
import bash from "./bash.js";
import ls from "./ls.js";
import glob from "./glob.js";
import grep from "./grep.js";
import subagent from "./subagent.js";
import toolsearch from "./toolsearch.js";
import compact from "./compact.js";

export const BUILTIN_TOOLS = [read, write, edit, bash, ls, glob, grep, subagent, toolsearch, compact];

export class ToolRegistry {
	/** @param {{ external?: () => any[] }} opts external 返回当前可用的外部工具（热更新） */
	constructor({ external } = {}) {
		this.builtins = BUILTIN_TOOLS;
		this.external = external || (() => []);
	}

	/** 外部工具中需要先搜索加载的 */
	deferredTools() {
		return this.external().filter((t) => !t.alwaysLoad);
	}

	/** 本轮发给模型的工具 */
	activeTools(agent, { subagent = false } = {}) {
		const ext = this.external();
		const loaded = ext.filter((t) => t.alwaysLoad || agent.loadedTools.has(t.name));
		let list = [...this.builtins, ...loaded];
		if (subagent) list = list.filter((t) => t.name !== "subagent" && t.name !== "compact");
		// compact 只在上下文用到压缩阈值一半后才提供，避免小模型滥用
		else if (agent.contextTokens() < agent.model.compactAt * 0.5) list = list.filter((t) => t.name !== "compact");
		if (!ext.some((t) => !t.alwaysLoad)) list = list.filter((t) => t.name !== "toolsearch"); // 无可搜索工具时隐藏
		return list;
	}
}
