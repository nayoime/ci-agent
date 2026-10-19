// 工具名/参数映射：内部规范名 ⇄ 发给模型的风格（native / claude）
// 解码时总是同时接受两种风格及常见别名，提高小模型调用成功率。

/** 其他代理常见的工具名 → 本项目规范名 */
const ALIASES = {
	multiedit: "edit",
	str_replace: "edit",
	str_replace_editor: "edit",
	view: "read",
	cat: "read",
	read_file: "read",
	write_file: "write",
	create_file: "write",
	edit_file: "edit",
	shell: "bash",
	run: "bash",
	exec: "bash",
	execute: "bash",
	run_command: "bash",
	list: "ls",
	list_dir: "ls",
	list_directory: "ls",
	find: "glob",
	search: "grep",
	task: "subagent",
	agent: "subagent",
	tool_search: "toolsearch",
	toolsearch: "toolsearch",
};

const pascal = (s) =>
	s
		.split(/[_\-\s]+/)
		.filter(Boolean)
		.map((p) => p[0].toUpperCase() + p.slice(1))
		.join("");

function renameSchema(schema, rename) {
	if (!rename) return schema;
	const inv = Object.fromEntries(Object.entries(rename).map(([w, c]) => [c, w]));
	const props = {};
	for (const [k, v] of Object.entries(schema.properties || {})) props[inv[k] ?? k] = v;
	return { ...schema, properties: props, required: schema.required?.map((k) => inv[k] ?? k) };
}

function stripUndefined(o) {
	return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null));
}

/** 宽松 JSON 解析：去掉代码块围栏、尾逗号，补全括号 */
export function parseArgs(raw) {
	if (raw && typeof raw === "object") return raw;
	let s = String(raw ?? "").trim();
	if (!s) return {};
	s = s.replace(/^```(?:json)?\s*|\s*```$/g, "");
	const tries = [s, s.replace(/,\s*([}\]])/g, "$1")];
	// 截断的 JSON：补全括号
	const opens = (s.match(/{/g) || []).length - (s.match(/}/g) || []).length;
	if (opens > 0) tries.push(s + "}".repeat(opens));
	for (const t of tries) {
		try {
			const v = JSON.parse(t);
			if (v && typeof v === "object" && !Array.isArray(v)) return v;
			if (typeof v === "string") return parseArgs(v); // 二次编码的 JSON
		} catch {}
	}
	throw new Error(`参数不是合法 JSON：${s.slice(0, 200)}`);
}

export function makeCodec(tools, style = "native") {
	const claude = style === "claude";
	const byName = new Map();
	const wire = new Map(); // 规范名 → { name, parameters, toWire }

	for (const t of tools) {
		const c = t.claude || {};
		const w = claude
			? {
					name: t.external ? t.name : c.name || pascal(t.name),
					parameters: c.parameters || renameSchema(t.parameters, c.rename),
					toWire:
						c.toWire ||
						(c.rename
							? (a) => {
									const inv = Object.fromEntries(Object.entries(c.rename).map(([wk, ck]) => [ck, wk]));
									return Object.fromEntries(Object.entries(a).map(([k, v]) => [inv[k] ?? k, v]));
								}
							: (a) => a),
				}
			: { name: t.name, parameters: t.parameters, toWire: (a) => a };
		wire.set(t.name, w);
		for (const n of [t.name, w.name, c.name].filter(Boolean)) byName.set(n.toLowerCase(), t);
	}

	const lookup = (raw) => {
		const n = String(raw || "").trim();
		const lower = n.toLowerCase();
		return byName.get(lower) || byName.get(ALIASES[lower]) || byName.get(lower.replace(/^functions[.:]/, ""));
	};

	return {
		/** 发给模型的工具定义 */
		schemas: tools.map((t) => {
			const w = wire.get(t.name);
			return { name: w.name, description: t.description, parameters: w.parameters };
		}),
		wireName: (name) => wire.get(name)?.name ?? name,
		/** 规范调用 → 模型风格（用于回放历史） */
		encode(name, args) {
			const w = wire.get(name);
			return w ? { name: w.name, args: stripUndefined(w.toWire(args || {})) } : { name, args: args || {} };
		},
		/** 模型返回 → 规范调用；失败返回 { error } */
		decode(rawName, rawArgs) {
			const tool = lookup(rawName);
			if (!tool) {
				const names = tools.map((t) => wire.get(t.name).name).join("、");
				return { name: rawName, args: {}, error: `没有名为 ${rawName} 的工具。可用工具：${names}` };
			}
			let args;
			try {
				args = parseArgs(rawArgs);
			} catch (e) {
				return { name: tool.name, args: {}, error: `${e.message}\n请修正参数后重新调用。` };
			}
			if (tool.normalize) args = tool.normalize(args);
			else if (tool.claude?.rename) {
				for (const [w, c] of Object.entries(tool.claude.rename)) {
					if (args[w] !== undefined && args[c] === undefined) args[c] = args[w];
					delete args[w];
				}
			}
			args = stripUndefined(args);
			const missing = (tool.parameters.required || []).filter((k) => args[k] === undefined);
			if (missing.length) return { name: tool.name, args, error: `缺少必填参数：${missing.join("、")}` };
			return { name: tool.name, args, tool };
		},
	};
}
