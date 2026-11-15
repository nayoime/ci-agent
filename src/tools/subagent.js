// 子代理：并行执行多个独立任务，每个子代理有独立上下文，只把最终结果返回给主代理
export default {
	name: "subagent",
	label: "子代理",
	description:
		"把相互独立的任务交给子代理并行处理。每个子代理有独立上下文和全部基础工具，完成后只返回结论。prompt 要写清楚目标、范围和要返回的内容。",
	parameters: {
		type: "object",
		properties: {
			tasks: {
				type: "array",
				description: "任务列表，并行执行",
				items: {
					type: "object",
					properties: {
						description: { type: "string", description: "任务简述（3~8 个字）" },
						prompt: { type: "string", description: "给子代理的完整任务说明" },
						thinking: { type: "string", enum: ["off", "minimal", "low", "medium", "high", "xhigh", "max"], description: "子代理的思考强度。不填就是 off，查找、读文件、统计、改代码都用 off；只有需要复杂推理时才开" },
					},
					required: ["prompt"],
				},
			},
		},
		required: ["tasks"],
	},
	// Claude Code 的 Task 工具一次一个任务；同一轮多个 Task 调用由代理合并成一次多任务调用（mergeSubagentCalls）
	claude: {
		name: "Task",
		parameters: {
			type: "object",
			properties: {
				description: { type: "string", description: "任务简述（3~8 个字）" },
				prompt: { type: "string", description: "给子代理的完整任务说明" },
				subagent_type: { type: "string", description: "子代理类型，填 general-purpose" },
				thinking: { type: "string", enum: ["off", "minimal", "low", "medium", "high", "xhigh", "max"], description: "子代理的思考强度。不填就是 off，只有需要复杂推理时才开" },
			},
			required: ["description", "prompt"],
		},
		toWire: (a) => ({ ...a.tasks?.[0], subagent_type: "general-purpose" }),
	},
	normalize(a) {
		let tasks = a.tasks;
		if (typeof tasks === "string") {
			try {
				tasks = JSON.parse(tasks);
			} catch {}
		}
		if (!Array.isArray(tasks)) tasks = a.prompt ? [{ description: a.description, prompt: a.prompt, ...(a.thinking ? { thinking: a.thinking } : {}) }] : undefined;
		if (Array.isArray(tasks)) tasks = tasks.map((t) => (typeof t === "string" ? { prompt: t } : t));
		return { tasks };
	},
	parallelSafe: true,

	async run({ tasks }, ctx) {
		if (!Array.isArray(tasks) || !tasks.length) throw new Error("tasks 不能为空");
		if (!ctx.spawnAgents) throw new Error("子代理内不能再创建子代理");
		const results = await ctx.spawnAgents(tasks);
		const content = results
			.map((r, i) => `## 子任务 ${i + 1}：${tasks[i].description || ""}\n${r.ok ? r.text : `失败：${r.error}`}`)
			.join("\n\n");
		const details = { lanes: results.map((r, i) => ({ description: tasks[i].description || "", ok: r.ok, ...r.transcript })) };
		return { content, isError: results.every((r) => !r.ok), details };
	},
};
