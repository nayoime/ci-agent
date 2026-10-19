// 上下文压缩：模型可主动调用；超过模型配置的 compactAt 时代理也会自动执行同一逻辑
export default {
	name: "compact",
	label: "压缩上下文",
	readOnly: true,
	description: "把较早的对话压缩成摘要，释放上下文空间。阶段性任务完成、或接下来要读大量内容时使用。focus 指明摘要要重点保留的信息。",
	parameters: {
		type: "object",
		properties: {
			focus: { type: "string", description: "摘要需重点保留的内容（可选）" },
		},
	},
	claude: { name: "Compact" },

	async run({ focus }, ctx) {
		ctx.agent.requestCompact(focus || "");
		return "好的，本轮工具执行完后会压缩较早的上下文。";
	},
};
