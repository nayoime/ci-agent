// 工具搜索：MCP 等外部工具默认不发给模型（省上下文），按需搜索并加载
export default {
	name: "toolsearch",
	label: "搜索工具",
	readOnly: true,
	description:
		"搜索并加载未直接提供的扩展工具（MCP 工具）。query 写关键词；写 select:工具名1,工具名2 直接加载指定工具。加载后即可直接调用。",
	parameters: {
		type: "object",
		properties: {
			query: { type: "string", description: "关键词，或 select:工具名" },
			limit: { type: "number", description: "最多结果数，默认 5" },
		},
		required: ["query"],
	},
	claude: { name: "ToolSearch", rename: { max_results: "limit" } },

	async run({ query, limit = 5 }, ctx) {
		const pool = ctx.registry.deferredTools();
		if (!pool.length) return "当前没有可加载的扩展工具（未启用任何 MCP 服务器）。";
		const q = String(query).trim();
		let hits;
		if (/^select:/i.test(q)) {
			const want = q.slice(7).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
			hits = pool.filter((t) => want.includes(t.name.toLowerCase()) || want.includes(t.shortName?.toLowerCase()));
		} else {
			const words = q.toLowerCase().split(/\s+/).filter(Boolean);
			hits = pool
				.map((t) => {
					const name = t.name.toLowerCase();
					const hay = `${name} ${t.description || ""}`.toLowerCase();
					const score = words.reduce((s, w) => s + (name.includes(w) ? 3 : 0) + (hay.includes(w) ? 1 : 0), 0);
					return { t, score };
				})
				.filter((x) => x.score > 0)
				.sort((a, b) => b.score - a.score)
				.slice(0, limit)
				.map((x) => x.t);
		}
		if (!hits.length) {
			const servers = [...new Set(pool.map((t) => t.server))].join("、");
			return `没有匹配“${q}”的工具。可用 MCP 服务器：${servers}。换个关键词，或用服务器名搜索。`;
		}
		for (const t of hits) ctx.agent.loadedTools.add(t.name);
		return (
			`已加载 ${hits.length} 个工具，现在可以直接调用：\n\n` +
			hits.map((t) => `### ${t.name}\n${t.description || ""}\n参数：${JSON.stringify(t.parameters)}`).join("\n\n")
		);
	},
};
