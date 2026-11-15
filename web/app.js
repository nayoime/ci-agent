// Ciallo Agent 网页端（原生 JS，无构建）
import { renderMarkdown, esc } from "./markdown.js";
import { logoSVG, iconSVG } from "./logo.js";

const $ = (s, el = document) => el.querySelector(s);
/** 空状态：完整字标，带入场动画（字母弹出 → O 环画出 → 表情出现），之后常驻眨眼、悬停挥手 */
const emptyLogo = () => {
	const d = document.createElement("div");
	d.className = "empty-logo";
	d.setAttribute("aria-hidden", "true");
	d.innerHTML = logoSVG("anim");
	return d;
};
const h = (tag, attrs = {}, ...kids) => {
	const el = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs)) {
		if (v == null || v === false) continue;
		if (k === "class") el.className = v;
		else if (k === "html") el.innerHTML = v;
		else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
		else el.setAttribute(k, v === true ? "" : v);
	}
	for (const k of kids.flat()) if (k != null && k !== false) el.append(k instanceof Node ? k : document.createTextNode(String(k)));
	return el;
};

// 品牌：侧栏 O 图标、首屏空状态字标（内联 SVG 才能做动画）
$(".logo").innerHTML = iconSVG();
$(".empty-logo").innerHTML = logoSVG("anim");

// ───────────── 状态 ─────────────
const S = {
	token: null,
	cwd: localStorage.getItem("ci.cwd") || "",
	sessionId: null,
	state: null, // /api/state
	running: false,
	attachments: [],
	cards: new Map(), // 工具调用 id → 卡片
	live: null, // 当前流式输出的助手消息
};

// 令牌：从地址栏 #token= 读取后存入 sessionStorage，并从地址栏移除
{
	const m = /token=([\w-]+)/.exec(location.hash);
	if (m) {
		sessionStorage.setItem("ci.token", m[1]);
		history.replaceState(null, "", location.pathname);
	}
	S.token = sessionStorage.getItem("ci.token");
}

async function api(path, { method = "GET", body } = {}) {
	const res = await fetch(path, {
		method,
		headers: { "x-ci-token": S.token || "", ...(body ? { "Content-Type": "application/json" } : {}) },
		body: body ? JSON.stringify(body) : undefined,
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
	return data;
}
const q = (o) => "?" + new URLSearchParams(o).toString();

let toastTimer;
function toast(text, err = false) {
	const t = $("#toast");
	t.textContent = text;
	t.className = `toast${err ? " err" : ""}`;
	// 重新弹出才能排到最上层（盖过已打开的对话框）
	if (t.matches(":popover-open")) t.hidePopover();
	t.showPopover();
	requestAnimationFrame(() => t.classList.add("show"));
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => {
		t.classList.remove("show");
		setTimeout(() => t.matches(":popover-open") && !t.classList.contains("show") && t.hidePopover(), 300);
	}, err ? 4000 : 2600);
}
const fmtK = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + "K" : String(n));
/** 粗略估算 token（与后端一致）：中日韩约 0.8/字，其他约 3.2 字符/token */
const estTok = (t) => {
	const cjk = (t.match(/[\u3000-\u9fff\uac00-\ud7af\uff00-\uffef]/g) || []).length;
	return cjk * 0.8 + (t.length - cjk) / 3.2;
};
const tokLine = (up, down, tps, live) => [
	h("span", { title: "上传（提示词）token" }, `↑ ${fmtK(Math.round(up))}`),
	h("span", { title: live ? "生成 token（实时估算）" : "生成 token" }, `↓ ${live ? "~" : ""}${fmtK(Math.round(down))}`),
	tps ? h("span", { title: "生成速度" }, `${tps} tok/s`) : null,
].filter(Boolean);
/** 一次模型调用的统计：↑ 上传（提示词）↓ 下载（生成）· 速度 */
function statsEl(st, cls = "stats") {
	if (!st) return null;
	const parts = [h("span", { title: "上传：本次提示词 token" + (st.cacheRead ? `，其中 ${st.cacheRead} 命中缓存` : "") }, `↑ ${fmtK(st.input)}`, st.cacheRead ? h("i", {}, ` 缓存 ${fmtK(st.cacheRead)}`) : null)];
	parts.push(h("span", { title: "下载：本次生成 token" }, `↓ ${fmtK(st.output)}`));
	if (st.tps) parts.push(h("span", { title: "生成速度" }, `${st.tps} tok/s`));
	if (st.ttft) parts.push(h("span", { title: "首个 token 延迟" }, `首字 ${(st.ttft / 1000).toFixed(1)}s`));
	return h("div", { class: cls }, ...parts);
}
const fmtTime = (ms) => {
	const d = new Date(ms);
	const today = new Date().toDateString() === d.toDateString();
	return today ? d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) : d.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
};

// ───────────── 工具展示 ─────────────
const toolMeta = (name) => S.state?.tools.find((t) => t.name === name);
const curModel = () => S.state?.models.find((m) => m.id === $("#model-select").value);
function toolLabel(name) {
	if (name?.startsWith("mcp__")) {
		const [, server, tool] = name.split("__");
		return `${server} · ${tool}`;
	}
	return toolMeta(name)?.label || name;
}
function wireName(name) {
	const t = toolMeta(name);
	if (!t) return name;
	return curModel()?.toolStyle === "claude" ? t.claude || name : name;
}
function argSummary(name, a = {}) {
	switch (name) {
		case "read":
		case "write":
		case "ls":
			return a.path || ".";
		case "edit":
			return `${a.path}${a.edits?.length > 1 ? `（${a.edits.length} 处）` : ""}`;
		case "bash":
			return a.command;
		case "glob":
			return a.pattern + (a.path ? `  @ ${a.path}` : "");
		case "grep":
			return `/${a.pattern}/` + (a.glob ? `  ${a.glob}` : "") + (a.path ? `  @ ${a.path}` : "");
		case "subagent":
			return `${a.tasks?.length || 0} 个并行任务`;
		case "toolsearch":
			return a.query;
		case "compact":
			return a.focus || "";
		default:
			return JSON.stringify(a);
	}
}

const fmtSec = (s) => (s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`);
function toolCard({ id, name, args }, { running = false, register = true } = {}) {
	const status = h("span", { class: `st ${running ? "run" : ""}` }, running ? "运行中" : "");
	const spin = running ? h("span", { class: "spin", "aria-hidden": "true" }) : null;
	const arg = h("span", { class: "arg" }, args ? argSummary(name, args) : "生成参数中…");
	const timer = h("span", { class: "timer" });
	const stopBtn = h("button", { class: "tool-stop", type: "button", hidden: true, title: "只停止这个工具，代理继续运行" }, "停止");
	stopBtn.onclick = async (e) => {
		e.preventDefault();
		e.stopPropagation();
		stopBtn.disabled = true;
		stopBtn.textContent = "停止中…";
		const r = await api(`/api/sessions/${S.sessionId}/stoptool` + q({ cwd: S.cwd }), { method: "POST", body: { callId: id } }).catch((err) => toast(err.message, true));
		if (r && !r.ok) toast("这个工具已经结束了");
	};
	const summary = h(
		"summary",
		{},
		spin,
		h("span", { class: "name" }, toolLabel(name)),
		h("span", { class: "wire", title: "发送给模型的工具名" }, wireName(name)),
		arg,
		timer,
		stopBtn,
		status,
	);
	const argsPre = h("pre", {}, args ? JSON.stringify(args, null, 2) : "");
	const out = h("pre", {});
	const detail = h("div", { class: "detail" }, h("div", { class: "k" }, "参数"), argsPre, h("div", { class: "k" }, "结果"), out);
	const el = h("details", { class: `tool${running ? " running" : ""}${name === "bash" ? " cmd" : ""}` }, summary, detail);
	let tick = 0;
	let t0 = 0;
	const card = {
		el,
		name,
		lanes: null,
		setArgs(a) {
			arg.textContent = argSummary(name, a);
			argsPre.textContent = JSON.stringify(a, null, 2);
		},
		/** 开始执行：显示已用时长 / 上限，并给出停止按钮 */
		start(ev = {}) {
			el.classList.add("running");
			status.className = "st run";
			status.textContent = "";
			if (!summary.querySelector(".spin")) summary.prepend(h("span", { class: "spin", "aria-hidden": "true" }));
			t0 = ev.t0 || Date.now();
			const limit = ev.limit;
			const draw = () => {
				const s = Math.max(0, Math.round((Date.now() - t0) / 1000));
				timer.textContent = limit ? `${fmtSec(s)} / ${fmtSec(limit)}` : fmtSec(s);
				timer.classList.toggle("near", !!limit && s >= limit * 0.8);
			};
			draw();
			clearInterval(tick);
			tick = setInterval(draw, 1000);
			stopBtn.hidden = !S.sessionId;
		},
		append(chunk) {
			out.textContent = (out.textContent + chunk).slice(-20000);
			out.scrollTop = out.scrollHeight;
		},
		finish(content, isError) {
			clearInterval(tick);
			stopBtn.remove();
			el.classList.remove("running");
			summary.querySelector(".spin")?.remove();
			const s = t0 ? Math.round((Date.now() - t0) / 1000) : 0;
			timer.textContent = s >= 1 ? `用时 ${fmtSec(s)}` : "";
			timer.classList.remove("near");
			status.className = `st ${isError ? "err" : "ok"}`;
			status.textContent = isError ? "✕ 失败" : "✓";
			out.textContent = content;
			out.className = isError ? "err" : "";
			if (card.lanes) for (const l of card.lanes.values()) if (l.el.classList.contains("running")) { l.el.className = "lane done"; laneStatus(l, "完成"); }
		},
	};
	if (register) S.cards.set(id, card);
	return card;
}

/** 子代理泳道：每个子代理一个并排的小对话框，实时滚动 */
function laneOf(card, ev) {
	if (!card.lanes) {
		card.lanes = new Map();
		card.lanesEl = h("div", { class: "lanes" });
		card.el.after(card.lanesEl); // 放在 details 外面，折叠卡片时泳道仍可见
	}
	let lane = card.lanes.get(ev.index);
	if (!lane) {
		const st = h("span", { class: "lane-st" }, "启动中");
		const log = h("div", { class: "lane-log" });
		const foot = h("footer", { class: "lane-f" }, "↑ 0  ↓ 0");
		const el = h(
			"section",
			{ class: "lane running", "aria-label": `子代理 ${ev.index + 1}` },
			h("header", { class: "lane-h" }, h("span", { class: "n" }, String(ev.index + 1).padStart(2, "0")), h("span", { class: "t" }, ev.description || `子任务 ${ev.index + 1}`), st),
			log,
			foot,
		);
		lane = { el, st, log, foot, textEl: null, thinkEl: null, tools: 0, up: 0, down: 0, tps: 0, live: 0, t1: 0, steps: new Map(), pinned: true, raf: 0, dirty: new Set(), busyKey: null };
		// 是否跟随到底：只由用户滚动决定。内容一次长高很多时也不会丢掉跟随
		log.addEventListener("scroll", () => (lane.pinned = log.scrollHeight - log.scrollTop - log.clientHeight < 30), { passive: true });
		card.lanes.set(ev.index, lane);
		const sorted = [...card.lanes.entries()].sort((a, b) => a[0] - b[0]);
		card.lanesEl.replaceChildren(...sorted.map(([, l]) => l.el));
	}
	return lane;
}
/** 泳道统一按帧渲染：流式增量先进缓冲，每帧最多写一次 DOM、读一次布局 */
function laneSchedule(lane) {
	if (!lane.raf) lane.raf = requestAnimationFrame(() => laneRender(lane));
}
function laneRender(lane) {
	lane.raf = 0;
	for (const el of lane.dirty) {
		if (el.kind === "think") {
			el.body.innerHTML = renderMarkdown(el.buf);
			el.body.scrollTop = el.body.scrollHeight;
		} else if (el.kind === "text") el.innerHTML = renderMarkdown(el.buf);
	}
	lane.dirty.clear();
	if (lane.footDirty) (lane.footDirty = false), laneFoot(lane);
	if (lane.pinned) lane.log.scrollTop = lane.log.scrollHeight;
}
function laneAdd(lane, el) {
	lane.log.append(el);
	laneSchedule(lane);
}
/** 泳道底栏：运行中显示累计 + 本轮实时估算，结束后为总数 */
function laneFoot(lane) {
	const running = lane.live > 0;
	const tps = running && lane.t1 ? Math.round((lane.live / Math.max(0.3, (Date.now() - lane.t1) / 1000)) * 10) / 10 : lane.tps;
	lane.foot.replaceChildren(...tokLine(lane.up, lane.down + lane.live, tps, running));
}
function laneLive(lane, delta) {
	if (!lane.t1) lane.t1 = Date.now();
	lane.live += estTok(delta);
	lane.footDirty = true;
	laneSchedule(lane);
}
function laneThinking(lane, delta) {
	if (!lane.thinkEl) {
		const body = h("div", { class: "body text" });
		lane.thinkEl = h("details", { class: "thinking", open: true }, h("summary", {}, "思考中…"), body);
		Object.assign(lane.thinkEl, { body, buf: "", kind: "think" });
		laneAdd(lane, lane.thinkEl);
	}
	lane.thinkEl.buf += delta;
	lane.dirty.add(lane.thinkEl);
	laneSchedule(lane);
}
/** 思考结束：写入剩余内容，折叠起来，标题改回“思考过程” */
function laneThinkDone(lane) {
	const t = lane.thinkEl;
	if (!t) return;
	if (lane.dirty.delete(t)) t.body.innerHTML = renderMarkdown(t.buf);
	t.open = false;
	t.querySelector("summary").textContent = "思考过程";
	lane.thinkEl = null;
	laneSchedule(lane);
}
function laneText(lane, delta) {
	laneThinkDone(lane);
	if (!lane.textEl) {
		lane.textEl = h("div", { class: "text cursor" });
		Object.assign(lane.textEl, { buf: "", kind: "text" });
		laneAdd(lane, lane.textEl);
	}
	lane.textEl.buf += delta;
	lane.dirty.add(lane.textEl);
	laneSchedule(lane);
}
function laneTextDone(lane) {
	lane.textEl?.classList.remove("cursor");
	lane.textEl = null;
}
/** 状态文字：同样的内容不重复重建（否则每个 token 都重建一次转圈图标） */
function laneBusy(lane, text) {
	if (lane.busyKey === text) return;
	lane.busyKey = text;
	lane.st.replaceChildren(h("i", { class: "spin", "aria-hidden": "true" }), ` ${text}`);
}
function laneStatus(lane, text) {
	lane.busyKey = null;
	lane.st.textContent = text;
}

function onSubEvent(card, ev) {
	const lane = laneOf(card, ev);
	const e = ev.event;
	S.subLive = true;
	switch (e.type) {
		case "turn_start":
			laneThinkDone(lane);
			laneTextDone(lane);
			lane.live = 0;
			lane.t1 = 0;
			// 本地模型读长提示词时可能要等几秒，先给个等待状态
			laneBusy(lane, "等待模型");
			break;
		case "thinking":
			laneThinking(lane, e.delta);
			laneBusy(lane, "思考中");
			laneLive(lane, e.delta);
			break;
		case "text":
			laneText(lane, e.delta);
			laneBusy(lane, "输出中");
			laneLive(lane, e.delta);
			break;
		case "tool_start": {
			lane.tools++;
			laneThinkDone(lane);
			laneTextDone(lane);
			const tc = toolCard(e, { running: true, register: false });
			tc.start(e);
			lane.steps.set(e.id, tc);
			laneAdd(lane, tc.el);
			laneBusy(lane, toolLabel(e.name));
			break;
		}
		case "tool_update":
			lane.steps.get(e.id)?.append(e.chunk);
			break;
		case "tool_end":
			lane.steps.get(e.id)?.finish(e.content, e.isError);
			laneStatus(lane, `工具 ×${lane.tools}`);
			laneSchedule(lane);
			break;
		case "error":
			laneThinkDone(lane);
			laneTextDone(lane);
			lane.el.className = "lane fail";
			laneStatus(lane, "失败");
			laneAdd(lane, h("div", { class: "text err" }, e.message || e.error || "出错"));
			break;
		case "assistant": {
			laneThinkDone(lane);
			laneTextDone(lane);
			const st = e.message?.stats;
			if (st) {
				lane.up += st.input;
				lane.down += st.output;
				if (st.tps) lane.tps = st.tps;
				S.run.subUp += st.input;
				S.run.subDown += st.output;
				runMeter();
			}
			lane.live = 0;
			laneFoot(lane);
			if (e.stopReason === "tool_calls") break;
		}
		// fallthrough
		case "done":
			if (!lane.el.classList.contains("fail")) {
				lane.el.className = "lane done";
				laneStatus(lane, `完成 · ${lane.tools} 次工具`);
			}
			break;
	}
}

/** 从会话里保存的子代理记录重建泳道 */
function replayLanes(card, lanes) {
	lanes.forEach((L, index) => {
		const lane = laneOf(card, { index, description: L.description });
		for (const x of L.log || []) {
			if (x.k === "think") laneAdd(lane, h("details", { class: "thinking" }, h("summary", {}, "思考过程"), h("div", { class: "body text", html: renderMarkdown(x.t) })));
			else if (x.k === "text") laneAdd(lane, h("div", { class: "text", html: renderMarkdown(x.t) }));
			else if (x.k === "tool") {
				lane.tools++;
				const tc = toolCard({ id: "", name: x.name, args: x.args }, { register: false });
				tc.finish(x.out ?? "（旧记录没有保存结果）", !x.ok);
				laneAdd(lane, tc.el);
			}
		}
		lane.el.className = `lane ${L.ok ? "done" : "fail"}`;
		laneStatus(lane, L.ok ? `完成 · ${lane.tools} 次工具` : "失败");
		Object.assign(lane, { up: L.up || 0, down: L.down || 0, tps: L.tps || 0 });
		laneFoot(lane);
		lane.pinned = false; // 回放的记录从顶部开始看
		lane.log.scrollTop = 0;
	});
}

// ───────────── 消息渲染 ─────────────
const box = () => $("#messages");
let stick = true;
function scrollDown(force) {
	const b = box();
	if (force || stick) b.scrollTop = b.scrollHeight;
}

function userEl(content) {
	const bubble = h("div", { class: "bubble" });
	if (typeof content === "string") bubble.append(content);
	else
		for (const b of content) {
			if (b.type === "image") bubble.append(h("img", { src: `data:${b.mime};base64,${b.data}`, alt: "用户附图" }));
			else bubble.append(b.text);
		}
	const el = h("div", { class: "msg user" });
	const del = h("button", { class: "del-turn", type: "button", title: "从上下文删除这轮对话（不回滚文件）", "aria-label": "删除这轮对话", onclick: () => deleteTurn(el) }, "×");
	el.append(del, bubble);
	return el;
}

/** 删除一轮对话：用户消息及其后的回复，只影响上下文 */
async function deleteTurn(el) {
	if (S.running) return toast("运行中不能删除对话", true);
	const turn = [...box().querySelectorAll(".msg.user")].indexOf(el);
	if (turn < 0 || !confirm("从上下文中删除这轮对话（这条消息和它之后的回复）？文件改动不会回滚。")) return;
	try {
		const v = await api(`/api/sessions/${S.sessionId}/deleteturn` + q({ cwd: S.cwd }), { method: "POST", body: { turn } });
		renderHistory(v.messages);
		updateMeter(v.contextTokens, v.contextWindow, v.compactAt);
	} catch (e) {
		toast(e.message, true);
	}
}

function attachCodeCopy(el) {
	for (const btn of el.querySelectorAll(".code .copy")) {
		btn.onclick = () => {
			navigator.clipboard.writeText(btn.closest(".code").querySelector("code").textContent);
			btn.textContent = "已复制";
			setTimeout(() => (btn.textContent = "复制"), 1200);
		};
	}
}

function assistantEl(msg, results) {
	const el = h("div", { class: "msg assistant" });
	for (const b of msg.content) {
		if (b.type === "thinking" && b.text?.trim()) {
			el.append(h("details", { class: "thinking" }, h("summary", {}, "思考过程"), h("div", { class: "body text", html: renderMarkdown(b.text.trim()) })));
		} else if (b.type === "text" && b.text) {
			const t = h("div", { class: "text", html: renderMarkdown(b.text) });
			attachCodeCopy(t);
			el.append(t);
		} else if (b.type === "tool_call") {
			if (b.mergedInto) continue; // 已合并到同轮第一个子代理调用，泳道显示在那张卡片里
			const card = toolCard(b);
			const r = results?.get(b.id);
			// 去掉附给模型的上下文状况（同 agent.js CONTEXT_NOTE_RE），与实时显示一致
			if (r) card.finish(r.content.replace(/\n\n〔上下文 [^〕]*〕$/, ""), r.isError);
			el.append(card.el);
			if (r?.details?.lanes) replayLanes(card, r.details.lanes);
		}
	}
	if (msg.stats) el.append(statsEl(msg.stats));
	return el;
}

function sysLine(text, err = false) {
	box().append(h("div", { class: `sys${err ? " err" : ""}` }, text));
	scrollDown();
}

function renderHistory(messages) {
	S.cards.clear();
	const results = new Map(messages.filter((m) => m.role === "tool").map((m) => [m.id, m]));
	const frag = document.createDocumentFragment();
	for (const m of messages) {
		if (m.role === "user" && m.summary) {
			frag.append(
				h("details", { class: "summary-card" }, h("summary", {}, "⟳ 较早的对话已压缩为摘要（点击查看）"), h("div", { class: "text", html: renderMarkdown(m.content.replace(/<\/?历史摘要>/g, "")) })),
			);
		} else if (m.role === "user") frag.append(userEl(m.content));
		else if (m.role === "assistant") frag.append(assistantEl(m, results));
	}
	box().replaceChildren(frag);
	if (!messages.length) box().append(h("div", { class: "empty" }, emptyLogo(), h("p", {}, "有什么要做的？")));
	scrollDown(true);
}

// 流式助手消息
function liveStart() {
	box().querySelector(".empty")?.remove();
	// 发出请求到模型开始输出之间（含工具执行完后）显示等待提示，收到第一段输出就移除
	const wait = h("div", { class: "waiting", role: "status" }, h("i", { class: "spin", "aria-hidden": "true" }), "等待模型回应…");
	const el = h("div", { class: "msg assistant" }, wait);
	box().append(el);
	S.live = { el, wait, thinking: null, thinkBody: null, text: null, textBuf: "", raf: 0 };
	return S.live;
}
function liveText(delta) {
	const L = S.live || liveStart();
	L.wait?.remove();
	if (L.thinking) L.thinking.open = false;
	if (!L.text) {
		L.text = h("div", { class: "text cursor" });
		L.el.append(L.text);
	}
	L.textBuf += delta;
	L.textDirty = true;
	liveSchedule(L);
}
function liveThinking(delta) {
	const L = S.live || liveStart();
	L.wait?.remove();
	if (!L.thinking) {
		L.thinkBody = h("div", { class: "body text" });
		L.thinking = h("details", { class: "thinking", open: true }, h("summary", {}, "思考中…"), L.thinkBody);
		L.thinkBuf = "";
		L.el.append(L.thinking);
	}
	L.thinkBuf += delta;
	L.thinkDirty = true;
	liveSchedule(L);
}
/** 主对话流式内容按帧渲染 */
function liveSchedule(L) {
	if (L.raf) return;
	L.raf = requestAnimationFrame(() => {
		L.raf = 0;
		if (L.thinkDirty) {
			L.thinkDirty = false;
			L.thinkBody.innerHTML = renderMarkdown(L.thinkBuf);
			L.thinkBody.scrollTop = L.thinkBody.scrollHeight;
		}
		if (L.textDirty) {
			L.textDirty = false;
			L.text.innerHTML = renderMarkdown(L.textBuf);
		}
		scrollDown();
	});
}

// ───────────── 本次任务 token（输入框下方） ─────────────
S.run = { up: 0, down: 0, live: 0, t1: 0, tps: 0, subUp: 0, subDown: 0 };
function resetRun() {
	S.run = { up: 0, down: 0, live: 0, t1: 0, tps: 0, subUp: 0, subDown: 0 };
	runMeter();
}
let runRaf = 0;
function runMeter() {
	if (runRaf) return;
	runRaf = requestAnimationFrame(() => {
		runRaf = 0;
		const R = S.run;
		const live = R.live > 0;
		const tps = live && R.t1 ? Math.round((R.live / Math.max(0.3, (Date.now() - R.t1) / 1000)) * 10) / 10 : R.tps;
		const el = $("#run-tokens");
		if (!R.up && !R.live && !R.subUp) return el.replaceChildren();
		el.replaceChildren(
			h("b", {}, S.running ? "本次" : "本次合计"),
			...tokLine(R.up, R.down + R.live, tps, live),
			...(R.subUp ? [h("span", { class: "sub" }, `子代理 ↑ ${fmtK(R.subUp)} ↓ ${fmtK(R.subDown)}`)] : []),
		);
	});
}
function runLive(delta) {
	if (!S.run.t1) S.run.t1 = Date.now();
	S.run.live += estTok(delta);
	runMeter();
}

// ───────────── 事件处理 ─────────────
function onAgentEvent(ev) {
	switch (ev.type) {
		case "turn_start":
			liveStart();
			S.run.live = 0;
			S.run.t1 = 0;
			break;
		case "thinking":
			liveThinking(ev.delta);
			runLive(ev.delta);
			break;
		case "text":
			liveText(ev.delta);
			runLive(ev.delta);
			break;
		case "tool_call_streaming": {
			const L = S.live || liveStart();
			L.wait?.remove();
			if (!S.cards.has(ev.id)) L.el.append(toolCard({ id: ev.id, name: ev.name }, { running: true }).el);
			scrollDown();
			break;
		}
		case "assistant": {
			// 用完整消息替换流式内容
			const el = assistantEl(ev.message);
			for (const b of ev.message.content) if (b.type === "tool_call") S.cards.get(b.id)?.start();
			if (S.live) S.live.el.replaceWith(el);
			else box().append(el);
			S.live = null;
			updateMeter(ev.contextTokens, ev.contextWindow);
			if (ev.message.stats) {
				S.run.up += ev.message.stats.input;
				S.run.down += ev.message.stats.output;
				S.run.tps = ev.message.stats.tps || S.run.tps;
			}
			S.run.live = 0;
			runMeter();
			scrollDown();
			break;
		}
		case "tool_start": {
			const c = S.cards.get(ev.id);
			c?.setArgs(ev.args);
			c?.start(ev);
			break;
		}
		case "tool_update":
			S.cards.get(ev.id)?.append(ev.chunk);
			break;
		case "tool_end": {
			const card = S.cards.get(ev.id);
			card?.finish(ev.content, ev.isError);
			// 中途切进来的会话没收到子代理实时事件，用结果里的记录补画
			if (card && !card.lanes && ev.details?.lanes) replayLanes(card, ev.details.lanes);
			break;
		}
		case "subagent": {
			const card = S.cards.get(ev.parentCallId);
			if (card) onSubEvent(card, ev);
			break;
		}
		case "compact_start":
			sysLine(`⟳ 正在压缩上下文${ev.reason === "auto" ? "（自动）" : ""}…`);
			break;
		case "compact_end":
			if (!ev.skipped) sysLine(`⟳ 已压缩：${fmtK(ev.before)} → ${fmtK(ev.after)} token，摘要了 ${ev.removed} 条消息`);
			else sysLine("没有可压缩的内容");
			updateMeter(ev.after);
			break;
		case "notice":
			sysLine(ev.text);
			break;
		case "error":
			S.live?.wait?.remove();
			S.live?.text?.classList.remove("cursor");
			sysLine(`出错：${ev.message}`, true);
			break;
		case "aborted":
			sysLine("已中止");
			break;
		case "idle":
			S.live?.wait?.remove();
			S.live?.text?.classList.remove("cursor");
			S.live = null;
			setRunning(false);
			runMeter();
			updateMeter(ev.contextTokens);
			break;
	}
}

function connectEvents() {
	const es = new EventSource(`/api/events?token=${encodeURIComponent(S.token)}`);
	es.onmessage = (e) => {
		const p = JSON.parse(e.data);
		if (p.kind === "agent") {
			const t = p.ev.type;
			if (t === "busy") markRunning(p.cwd, p.sessionId, true);
			if (t === "idle") (markRunning(p.cwd, p.sessionId, false), loadTreeSoon());
			if (samePath(p.cwd, S.cwd) && p.sessionId === S.sessionId) onAgentEvent(p.ev);
		} else if (p.kind === "mcp" || p.kind === "skills" || p.kind === "config") refreshState().then(() => settingsTab && renderSettings());
		else if (p.kind === "notice") toast(p.text, true);
	};
	es.onerror = () => {
		$("#status-text").textContent = "与服务的连接断开，正在重连…";
	};
	es.onopen = () => !S.running && ($("#status-text").textContent = "就绪");
}

// ───────────── 会话 ─────────────
function setRunning(on) {
	S.running = on;
	document.body.classList.toggle("busy", on);
	const btn = $("#send-btn");
	btn.textContent = on ? "停止" : "发送";
	btn.classList.toggle("stop", on);
	btn.setAttribute("aria-label", on ? "停止" : "发送");
	$("#status-text").textContent = on ? "运行中… 可继续输入，消息会在下一步送达（Esc 停止）" : "就绪 · 输入框为空时发送＝直接提交现有上下文";
	$("#compact-btn").disabled = on || !S.sessionId;
	if (!on) updateBlocked();
}

let meter = { tokens: 0, window: 0, compactAt: 0 };
function updateMeter(tokens = meter.tokens, window = meter.window, compactAt = meter.compactAt) {
	meter = { tokens, window, compactAt };
	const pct = window ? Math.min(100, (tokens / window) * 100) : 0;
	const fill = $(".ctx-fill");
	fill.style.width = pct + "%";
	fill.classList.toggle("warn", compactAt && tokens > compactAt * 0.85);
	$(".ctx-mark").style.left = window ? (compactAt / window) * 100 + "%" : "75%";
	$(".ctx-text").textContent = `${fmtK(tokens)} / ${fmtK(window)}`;
	$("#ctx-meter").setAttribute("aria-valuenow", Math.round(pct));
	$("#ctx-meter").title = `上下文 ${tokens} / ${window} token，超过 ${compactAt} 自动压缩`;
}

// ───────────── 侧栏：项目树（本地缓存，先画缓存再向服务刷新） ─────────────
S.tree = JSON.parse(localStorage.getItem("ci.tree") || "[]");
S.collapsed = new Set(JSON.parse(localStorage.getItem("ci.collapsed") || "[]"));
const samePath = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

async function loadTree() {
	try {
		S.tree = await api("/api/projects");
		localStorage.setItem("ci.tree", JSON.stringify(S.tree));
	} catch (e) {
		toast(e.message, true);
	}
	renderSidebar();
}
let treeTimer;
const loadTreeSoon = () => (clearTimeout(treeTimer), (treeTimer = setTimeout(loadTree, 300)));

function sessionItem(p, s) {
	const open = () => openSession(p.path, s.id);
	return h(
		"div",
		{ class: "session-item", role: "button", tabindex: "0", "aria-current": samePath(p.path, S.cwd) && s.id === S.sessionId ? "true" : "false", onclick: open, onkeydown: (e) => e.key === "Enter" && open() },
		h("span", { class: `dot${s.running ? " on" : ""}`, "aria-hidden": "true" }),
		h("span", { class: "t", title: s.title }, s.title),
		h("span", { class: "d" }, fmtTime(s.mtime)),
		h("button", { class: "del", type: "button", "aria-label": `删除会话 ${s.title}`, onclick: (e) => (e.stopPropagation(), deleteSession(p.path, s)) }, "✕"),
	);
}

function renderSidebar() {
	const nav = $("#session-list");
	if (!S.tree.length) return nav.replaceChildren(h("p", { class: "proj-empty" }, "还没有项目。点上面的按钮新建或打开一个。"));
	nav.replaceChildren(
		...S.tree.map((p) => {
			const open = !S.collapsed.has(p.path);
			const running = p.sessions.some((s) => s.running);
			const toggle = () => {
				open ? S.collapsed.add(p.path) : S.collapsed.delete(p.path);
				localStorage.setItem("ci.collapsed", JSON.stringify([...S.collapsed]));
				renderSidebar();
			};
			const head = h(
				"div",
				{ class: `proj-h${samePath(p.path, S.cwd) ? " cur" : ""}${p.exists ? "" : " missing"}`, title: p.exists ? p.path : `目录不存在：${p.path}` },
				h(
					"button",
					{ class: "proj-toggle", type: "button", "aria-expanded": String(open), onclick: toggle },
					h("span", { class: "chev", "aria-hidden": "true" }, "›"),
					h("span", { class: "pname" }, p.name),
					running ? h("span", { class: "pstate" }, h("i", { class: "spin", "aria-hidden": "true" }), "运行中") : null,
					h("span", { class: "pcount" }, p.sessions.length || ""),
				),
				h("button", { class: "mini", type: "button", title: "在此项目新建会话", "aria-label": `在 ${p.name} 新建会话`, disabled: !p.exists, onclick: () => newSession(p.path).catch((e) => toast(e.message, true)) }, "＋"),
				h("button", { class: "mini", type: "button", title: "项目提示词 / 工具 / 记忆", "aria-label": `编辑 ${p.name} 的项目提示词、工具和记忆`, disabled: !p.exists, onclick: () => openPromptDialog(p) }, "✎"),
				h("button", { class: "mini del", type: "button", title: "删除项目", "aria-label": `删除项目 ${p.name}`, onclick: () => deleteProject(p) }, "✕"),
			);
			const body = open
				? h("div", { class: "proj-sessions" }, p.sessions.length ? p.sessions.map((s) => sessionItem(p, s)) : h("p", { class: "proj-empty" }, p.exists ? "还没有会话" : "目录不存在"))
				: null;
			return h("section", { class: `proj${samePath(p.path, S.cwd) ? " cur" : ""}${running ? " running" : ""}` }, head, body);
		}),
	);
}

// ───────────── 项目提示词 ─────────────
let promptProject = null;
let promptDefault = "";
async function openPromptDialog(p) {
	try {
		const r = await api("/api/project-prompt" + q({ cwd: p.path }));
		promptProject = p.path;
		promptDefault = r.default;
		$("#prompt-dialog-title").replaceChildren("项目设置 ", h("span", { class: "crumb" }, p.name));
		$("#prompt-text").value = r.text;
		$("#prompt-tools").checked = r.tools;
		$("#prompt-memory").checked = r.memory;
		$("#memory-list").replaceChildren();
		for (const m of r.memories) addMemoryRow(m);
		memoryMeta();
		$("#prompt-dialog").showModal();
		$("#prompt-text").focus();
	} catch (e) {
		toast(e.message, true);
	}
}
/** 记忆库逐条可编辑：每条一个输入框 + 删除按钮 */
function addMemoryRow(text = "") {
	const row = h("div", { class: "row-item pp-mem-row" });
	// 回车不要触发表单提交（会直接关掉弹窗）
	const inp = h("input", { type: "text", "aria-label": "记忆内容", onkeydown: (e) => e.key === "Enter" && e.preventDefault() });
	inp.value = text;
	const del = () => (row.remove(), memoryMeta());
	row.append(h("span", { class: "pp-idx", "aria-hidden": "true" }), inp, h("button", { class: "small ghost danger", type: "button", "aria-label": "删除这条记忆", onclick: del }, "✕"));
	$("#memory-list").append(row);
	memoryMeta();
	return inp;
}
/** 记忆条数、空状态、记忆库关闭时的提示 */
function memoryMeta() {
	const list = $("#memory-list");
	const n = list.querySelectorAll(".pp-mem-row").length;
	list.querySelector(".row-empty")?.remove();
	if (!n) list.append(h("div", { class: "row-empty" }, "还没有记忆"));
	$("#memory-count").textContent = n ? `· ${n} 条` : "";
	const on = $("#prompt-memory").checked;
	$("#memory-off").hidden = on;
	$("#pp-mem").classList.toggle("off", !on);
}
$("#prompt-memory").addEventListener("change", memoryMeta);
const addMemoryFromInput = () => {
	const t = $("#memory-new").value.trim();
	if (!t) return;
	addMemoryRow(t);
	$("#memory-new").value = "";
};
$("#memory-add").onclick = addMemoryFromInput;
$("#memory-new").addEventListener("keydown", (e) => e.key === "Enter" && (e.preventDefault(), addMemoryFromInput()));
$("#prompt-reset").onclick = () => ($("#prompt-text").value = promptDefault);
$("#prompt-save").onclick = async () => {
	try {
		const memories = [...$("#memory-list").querySelectorAll("input")].map((i) => i.value.trim()).filter(Boolean);
		if ($("#memory-new").value.trim()) memories.push($("#memory-new").value.trim()), ($("#memory-new").value = "");
		await api("/api/project-prompt" + q({ cwd: promptProject }), {
			method: "PUT",
			body: { text: $("#prompt-text").value, tools: $("#prompt-tools").checked, memory: $("#prompt-memory").checked, memories },
		});
		$("#prompt-dialog").close();
		toast("已保存");
	} catch (e) {
		toast(e.message, true);
	}
};

/** 根据事件就地更新会话运行状态（不必请求服务） */
function markRunning(cwd, id, on) {
	const s = S.tree.find((p) => samePath(p.path, cwd))?.sessions.find((x) => x.id === id);
	if (s && s.running !== on) {
		s.running = on;
		renderSidebar();
	}
	updateBlocked();
}
/** 同一项目里别的会话在运行时，当前会话不能发送 */
function updateBlocked() {
	const p = S.tree.find((x) => samePath(x.path, S.cwd));
	const other = p?.sessions.find((x) => x.running && x.id !== S.sessionId);
	S.blocked = !!other && !S.running;
	document.body.classList.toggle("blocked", S.blocked);
	if (S.sessionId) $("#send-btn").disabled = S.blocked;
	if (S.blocked) $("#status-text").textContent = `“${other.title}”正在这个项目里运行，结束后才能在这里发送`;
	else if (!S.running) $("#status-text").textContent = "就绪";
}

async function deleteSession(cwd, s) {
	if (!confirm(`删除会话“${s.title}”？会话记录会被删除，不可恢复。`)) return;
	try {
		await api(`/api/sessions/${s.id}` + q({ cwd }), { method: "DELETE" });
	} catch (e) {
		return toast(e.message, true);
	}
	if (localStorage.getItem("ci.session." + cwd) === s.id) localStorage.removeItem("ci.session." + cwd);
	if (samePath(cwd, S.cwd) && s.id === S.sessionId) S.sessionId = null;
	await loadTree();
	if (!S.sessionId) clearView();
}

async function deleteProject(p) {
	if (!confirm(`从列表移除项目“${p.name}”？\n\n会删除 ${p.path}\\.ci（全部会话记录和项目记忆），不可恢复。\n项目本身的文件不会动。`)) return;
	try {
		await api("/api/projects" + q({ cwd: p.path }), { method: "DELETE" });
	} catch (e) {
		return toast(e.message, true);
	}
	localStorage.removeItem("ci.session." + p.path);
	S.collapsed.delete(p.path);
	localStorage.setItem("ci.collapsed", JSON.stringify([...S.collapsed]));
	const wasCurrent = samePath(p.path, S.cwd);
	if (wasCurrent) {
		S.cwd = "";
		S.sessionId = null;
		localStorage.removeItem("ci.cwd");
	}
	await loadTree();
	if (wasCurrent) clearView();
}

function clearView() {
	S.sessionId = null;
	renderHistory([]);
	enableComposer(false);
	setRunning(false);
	updateMeter(0, 0, 0);
	$("#session-title").textContent = "Ciallo Agent";
	box().querySelector(".empty p").textContent = S.tree.length ? "在左侧选择一个会话，或点项目旁的 ＋ 新建会话。" : "先新建或打开一个项目。";
	renderSidebar();
}

function enableComposer(on) {
	$("#input").disabled = !on;
	$("#send-btn").disabled = !on;
	$("#model-select").disabled = !on;
	$("#compact-model-select").disabled = !on;
	$("#subagent-model-select").disabled = !on;
	$("#subagent-toggle").disabled = !on;
	$("#compact-btn").disabled = !on || S.running;
}

function showSession(cwd, v) {
	S.cwd = cwd;
	S.sessionId = v.id;
	localStorage.setItem("ci.cwd", cwd);
	localStorage.setItem("ci.session." + cwd, v.id);
	$("#model-select").value = v.model;
	$("#compact-model-select").value = v.compactModel || "";
	$("#subagent-model-select").value = v.subagentModel || "";
	if (!samePath(cwd, S.subagentCwd)) loadSubagentToggle(cwd);
	setThinkingUI(v.thinking || "off");
	resetRun();
	renderHistory(v.messages);
	updateMeter(v.contextTokens, v.contextWindow, v.compactAt);
	setRunning(v.running);
	enableComposer(true);
	const first = v.messages.find((m) => m.role === "user" && !m.summary);
	const title = first ? (typeof first.content === "string" ? first.content : first.content.find((b) => b.text)?.text || "图片").slice(0, 60) : "新会话";
	$("#session-title").replaceChildren(h("span", { class: "crumb" }, cwd.split(/[\\/]/).filter(Boolean).pop()), title);
	if (S.collapsed.delete(cwd)) localStorage.setItem("ci.collapsed", JSON.stringify([...S.collapsed]));
	renderSidebar();
	updateBlocked();
	$("#input").focus();
	$("#sidebar").classList.remove("open");
}

async function openSession(cwd, id) {
	try {
		const v = await api(`/api/sessions/${id}` + q({ cwd }));
		const changed = !samePath(cwd, S.cwd);
		showSession(cwd, v);
		if (changed) refreshState().catch(() => {}); // 技能列表与项目有关
	} catch (e) {
		toast(e.message, true);
	}
}

async function newSession(cwd) {
	const v = await api("/api/sessions", { method: "POST", body: { cwd, model: $("#model-select").value || undefined, compactModel: $("#compact-model-select").value || undefined, subagentModel: $("#subagent-model-select").value || undefined, thinking: localStorage.getItem("ci.thinking") || "off" } });
	showSession(cwd, v);
	loadTree();
}

/** 打开（或新建后打开）项目：进入上次的会话；没有会话就新建一个 */
async function setProject(path, createName) {
	const r = await api("/api/projects", { method: "POST", body: createName ? { create: true, parent: path, name: createName } : { path } });
	await loadTree();
	const last = localStorage.getItem("ci.session." + r.path);
	const proj = S.tree.find((p) => samePath(p.path, r.path));
	const id = proj?.sessions.find((s) => s.id === last)?.id || proj?.sessions[0]?.id;
	if (id) await openSession(r.path, id);
	else await newSession(r.path);
}

async function refreshState() {
	S.state = await api("/api/state" + (S.cwd ? q({ cwd: S.cwd }) : ""));
	const sel = $("#model-select");
	const cur = sel.value;
	sel.replaceChildren(
		...S.state.models.map((m) => h("option", { value: m.id }, `${m.name}  · ${{ anthropic: "Anthropic", gemini: "Gemini" }[m.protocol] || "OpenAI"}`)),
	);
	sel.value = S.state.models.some((m) => m.id === cur) ? cur : S.state.defaultModel;
	const csel = $("#compact-model-select");
	const ccur = csel.value;
	csel.replaceChildren(h("option", { value: "" }, "压缩：同主模型"), ...S.state.models.map((m) => h("option", { value: m.id }, `压缩：${m.name}`)));
	csel.value = S.state.models.some((m) => m.id === ccur) ? ccur : "";
	const ssel = $("#subagent-model-select");
	const scur = ssel.value;
	ssel.replaceChildren(h("option", { value: "" }, "子代理：同主模型"), ...S.state.models.map((m) => h("option", { value: m.id }, `子代理：${m.name}`)));
	ssel.value = S.state.models.some((m) => m.id === scur) ? scur : "";
	setThinkingUI();
}

// ───────────── 输入区 ─────────────
async function send() {
	const input = $("#input");
	const text = input.value.trim();
	if (!S.sessionId) return;
	if (!text && !S.attachments.length) {
		// 空白提交：不追加任何 user 消息，把现有上下文原样发给模型
		if (S.running) return;
		box().querySelector(".empty")?.remove();
		if (S.blocked) return toast("这个项目里已有会话在运行", true);
		if (!confirm("输入框为空。要直接把现有上下文发给模型吗？\n（不会添加新的用户消息）")) return;
		resetRun();
		setRunning(true);
		sysLine("↻ 空白提交：已把现有上下文发给模型");
		try {
			await api(`/api/sessions/${S.sessionId}/prompt` + q({ cwd: S.cwd }), { method: "POST", body: {} });
		} catch (e) {
			toast(e.message, true);
			setRunning(false);
		}
		return;
	}
	if (S.blocked) return toast("这个项目里已有会话在运行", true);
	const images = S.attachments.map(({ mime, data }) => ({ mime, data }));
	input.value = "";
	autosize();
	S.attachments = [];
	$("#attachments").replaceChildren();
	box().querySelector(".empty")?.remove();
	box().append(userEl(images.length ? [...images.map((i) => ({ type: "image", ...i })), { type: "text", text }] : text));
	scrollDown(true);
	if (!S.running) {
		resetRun();
		setRunning(true);
		const t = $("#session-title");
		if (t.lastChild?.nodeType === 3 && t.lastChild.textContent === "新会话") t.lastChild.textContent = text.slice(0, 60);
	}
	try {
		const r = await api(`/api/sessions/${S.sessionId}/prompt` + q({ cwd: S.cwd }), { method: "POST", body: { text, images } });
		if (r.queued) toast("已加入队列，将在下一步送达");
	} catch (e) {
		toast(e.message, true);
		setRunning(false);
	}
}
function autosize() {
	const t = $("#input");
	t.style.height = "auto";
	t.style.height = Math.min(t.scrollHeight, 260) + "px";
}
async function abort() {
	await api(`/api/sessions/${S.sessionId}/abort` + q({ cwd: S.cwd }), { method: "POST" }).catch(() => {});
}

$("#composer").addEventListener("submit", (e) => {
	e.preventDefault();
	if (S.running && !$("#input").value.trim()) abort();
	else send();
});
$("#input").addEventListener("input", autosize);
$("#input").addEventListener("keydown", (e) => {
	if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
		e.preventDefault();
		send();
	}
});
document.addEventListener("keydown", (e) => {
	if (e.key === "Escape" && S.running && !document.querySelector("dialog[open]")) abort();
});
$("#input").addEventListener("paste", (e) => {
	for (const item of e.clipboardData.items) {
		if (!item.type.startsWith("image/")) continue;
		e.preventDefault();
		const reader = new FileReader();
		reader.onload = () => {
			const [, mime, data] = /^data:(.*?);base64,(.*)$/.exec(reader.result);
			const att = { mime, data };
			S.attachments.push(att);
			const el = h("div", { class: "att" }, h("img", { src: reader.result, alt: "待发送的图片" }), h("button", { type: "button", "aria-label": "移除图片", onclick: () => (S.attachments.splice(S.attachments.indexOf(att), 1), el.remove()) }, "✕"));
			$("#attachments").append(el);
		};
		reader.readAsDataURL(item.getAsFile());
	}
});
box().addEventListener("scroll", () => {
	const b = box();
	stick = b.scrollHeight - b.scrollTop - b.clientHeight < 80;
});
$("#model-select").onchange = async (e) => {
	if (!S.sessionId) return;
	const v = await api(`/api/sessions/${S.sessionId}/model` + q({ cwd: S.cwd }), { method: "PUT", body: { model: e.target.value } }).catch((err) => toast(err.message, true));
	if (v) {
		updateMeter(v.contextTokens, v.contextWindow, v.compactAt);
		toast(`已切换到 ${curModel()?.name}`);
		setThinkingUI();
	}
};
$("#compact-model-select").onchange = async (e) => {
	if (!S.sessionId) return;
	const r = await api(`/api/sessions/${S.sessionId}/compactmodel` + q({ cwd: S.cwd }), { method: "PUT", body: { model: e.target.value } }).catch((err) => toast(err.message, true));
	if (r) toast(r.compactModel ? `压缩改用 ${S.state.models.find((m) => m.id === r.compactModel)?.name}` : "压缩使用主模型");
};
$("#subagent-model-select").onchange = async (e) => {
	if (!S.sessionId) return;
	const r = await api(`/api/sessions/${S.sessionId}/subagentmodel` + q({ cwd: S.cwd }), { method: "PUT", body: { model: e.target.value } }).catch((err) => toast(err.message, true));
	if (r) toast(r.subagentModel ? `子代理改用 ${S.state.models.find((m) => m.id === r.subagentModel)?.name}` : "子代理使用主模型");
};
// 子代理开关（项目级，存 .ci/project.json）：关掉后子代理工具不发给模型
async function loadSubagentToggle(cwd) {
	S.subagentCwd = cwd;
	const r = await api("/api/project-prompt" + q({ cwd })).catch(() => null);
	if (r && samePath(cwd, S.cwd)) $("#subagent-toggle").checked = r.subagent !== false;
}
$("#subagent-toggle").onchange = async (e) => {
	const on = e.target.checked;
	try {
		await api("/api/project-prompt" + q({ cwd: S.cwd }), { method: "PUT", body: { subagent: on } });
		toast(on ? "子代理已开启" : "子代理已关闭（下一轮生效）");
	} catch (err) {
		e.target.checked = !on;
		toast(err.message, true);
	}
};
// 思考档位（输入框上方）：按当前模型支持的档位显示；会话级，运行中修改下一轮生效
const LEVEL_NAME = { off: "关", minimal: "极低", low: "低", medium: "中", high: "高", xhigh: "超高", max: "最大" };
const LEVELS = Object.keys(LEVEL_NAME);
S.thinking = localStorage.getItem("ci.thinking") || "off";
/** 选中的档位模型不支持时，高亮它实际会落到的档位（与后端 snapLevel 一致） */
function snapUI(have, level) {
	if (have.includes(level)) return level;
	const w = LEVELS.indexOf(level);
	const pool = w === 0 ? have : have.filter((l) => l !== "off");
	return pool.reduce((b, l) => (Math.abs(LEVELS.indexOf(l) - w) < Math.abs(LEVELS.indexOf(b) - w) ? l : b), pool[0] || "off");
}
function setThinkingUI(level = S.thinking) {
	S.thinking = level;
	const have = curModel()?.thinkLevels || ["off"];
	const seg = $("#thinking-seg");
	const toggle = have.length === 2; // 只有开关
	const shown = snapUI(have, level);
	seg.replaceChildren(
		h("span", { class: "seg-label" }, "思考"),
		...have.map((l) =>
			h("button", { type: "button", "aria-pressed": String(l === shown), onclick: () => pickThinking(l) }, toggle ? (l === "off" ? "关" : "开") : LEVEL_NAME[l] || l),
		),
	);
	seg.hidden = have.length < 2;
}
async function pickThinking(level) {
	setThinkingUI(level);
	localStorage.setItem("ci.thinking", level);
	if (S.sessionId) await api(`/api/sessions/${S.sessionId}/thinking` + q({ cwd: S.cwd }), { method: "PUT", body: { thinking: level } }).catch((e) => toast(e.message, true));
}

// 主题切换：深色 ⇄ 浅色（默认深色）
const THEMES = [["dark", "●", "主题：深色"], ["light", "○", "主题：浅色"]];
function applyTheme(t) {
	const [name, icon, label] = THEMES.find((x) => x[0] === t) || THEMES[0];
	document.documentElement.dataset.theme = name;
	localStorage.setItem("ci.theme", name);
	$("#theme-btn").textContent = icon;
	$("#theme-btn").title = label;
	$("#theme-btn").setAttribute("aria-label", label);
}
applyTheme(localStorage.getItem("ci.theme"));
$("#theme-btn").onclick = () => {
	applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
};

$("#compact-btn").onclick = async () => {
	$("#compact-btn").disabled = true;
	try {
		const v = await api(`/api/sessions/${S.sessionId}/compact` + q({ cwd: S.cwd }), { method: "POST", body: {} });
		renderHistory(v.messages);
		updateMeter(v.contextTokens, v.contextWindow, v.compactAt);
		if (!v.ok) toast("没有可压缩的内容");
	} catch (e) {
		toast(e.message, true);
	}
	$("#compact-btn").disabled = false;
};
$("#menu-btn").onclick = () => $("#sidebar").classList.toggle("open");

// ───────────── 选择项目 ─────────────
async function browse(path) {
	try {
		const r = await api("/api/fs/dirs" + q({ path: path || "" }));
		$("#browse-path").textContent = r.path;
		const list = $("#dir-browser");
		list.replaceChildren();
		if (r.parent !== null) list.append(h("button", { type: "button", onclick: () => browse(r.parent) }, "⬆ 上一级"));
		if (r.path) list.append(h("button", { type: "button", class: "primary", style: "font-family:inherit", onclick: () => pickProject(r.path) }, `✓ 使用此目录：${r.path}`));
		for (const d of r.dirs) list.append(h("button", { type: "button", onclick: () => browse(d.path) }, `📁 ${d.name}`));
		$("#project-path").value = r.path;
	} catch (e) {
		toast(e.message, true);
	}
}
async function pickProject(p, createName) {
	try {
		await setProject(p, createName);
		$("#project-dialog").close();
	} catch (e) {
		toast(e.message, true);
	}
}
$("#new-project").onclick = () => {
	// 最近用过但已从侧栏移除的项目也列出来
	const known = new Set(S.tree.map((p) => p.path.toLowerCase()));
	const extra = (S.state?.projects || []).filter((p) => !known.has(p.path.toLowerCase()));
	const all = [...S.tree, ...extra];
	$("#recent-projects").replaceChildren(
		...(all.length ? all.map((p) => h("button", { type: "button", onclick: () => pickProject(p.path) }, p.path)) : [h("p", { class: "desc" }, "暂无")]),
	);
	$("#project-path").value = "";
	$("#new-folder-name").value = "";
	browse(S.cwd ? S.cwd.replace(/[\\/][^\\/]+[\\/]?$/, "") : "");
	$("#project-dialog").showModal();
};
$("#project-open").onclick = () => pickProject($("#project-path").value.trim());
$("#project-path").addEventListener("keydown", (e) => e.key === "Enter" && (e.preventDefault(), pickProject(e.target.value.trim())));
function createFolder() {
	const parent = $("#browse-path").textContent;
	const name = $("#new-folder-name").value.trim();
	if (!parent) return toast("先在下方浏览到要放新项目的父目录", true);
	if (!name) return toast("请输入文件夹名", true);
	pickProject(parent, name);
}
$("#new-folder-create").onclick = createFolder;
$("#new-folder-name").addEventListener("keydown", (e) => e.key === "Enter" && (e.preventDefault(), createFolder()));

// ───────────── 设置 ─────────────
let settingsTab = null;
let cfgDraft = null;

const field = (label, input, hint, cls = "") => h("label", { class: `field ${cls}` }, label, input, hint ? h("span", { class: "hint" }, hint) : null);
const inp = (obj, key, type = "text", attrs = {}) =>
	h("input", {
		type,
		value: obj[key] ?? "",
		...attrs,
		oninput: (e) => {
			const v = e.target.value;
			if (type === "number") v === "" ? delete obj[key] : (obj[key] = Number(v));
			else obj[key] = v;
		},
	});
const sel = (obj, key, options, after) => {
	const s = h("select", { onchange: (e) => ((obj[key] = e.target.value), after?.()) }, ...options.map(([v, t]) => h("option", { value: v }, t)));
	s.value = obj[key] ?? options[0][0];
	return s;
};
const toggle = (checked, onchange, label) =>
	h("span", { class: "switch" }, h("input", { type: "checkbox", role: "switch", checked, "aria-label": label, onchange: (e) => onchange(e.target.checked) }), h("span", { "aria-hidden": "true" }));

/** 请求参数的简短显示：{"reasoning_effort":"low"} → reasoning_effort: "low" */
const fmtParams = (v) => (v && Object.keys(v).length ? JSON.stringify(v).slice(1, -1).replace(/":/g, '": ').replace(/"([\w-]+)":/g, "$1:") : "（不发参数）");

/**
 * 思考档位：官方接口用固定映射（只读展示），其他接口选“自定义”，逐档勾选并填写请求参数。
 * 自定义存为 thinkLevels 对象：{ 档位: 合并进请求体的参数 }，"off": null 表示不能关
 */
function thinkEditor(m, id) {
	const wrap = h("div", { class: "think-ed" });
	const official = S.state?.thinkOfficial || {};
	const mode = () => (official[m.thinkStyle] ? m.thinkStyle : "custom");
	/** 进入自定义：没有映射对象时，从当前生效的映射起步（兼容旧的预设风格和档位数组） */
	const initCustom = () => {
		if (m.thinkLevels && typeof m.thinkLevels === "object" && !Array.isArray(m.thinkLevels)) return;
		const base = official[m.thinkStyle]?.map || S.state?.models.find((x) => x.id === id)?.thinkMap || { off: {} };
		m.thinkLevels = Object.fromEntries(LEVELS.filter((l) => l in base).map((l) => [l, structuredClone(base[l])]));
		if (!("off" in base)) m.thinkLevels.off = null;
	};
	const render = () => {
		const cur = mode();
		if (cur === "custom") initCustom();
		const pick = h(
			"select",
			{
				"aria-label": "思考接口",
				onchange: (e) => {
					const v = e.target.value;
					if (v === "custom") initCustom(), (m.thinkStyle = "custom");
					else m.thinkStyle = v;
					render();
				},
			},
			...Object.entries(official).map(([k, o]) => h("option", { value: k }, o.label)),
			h("option", { value: "custom" }, "自定义"),
		);
		pick.value = cur;
		const rows = h("div", { class: "think-map" });
		if (cur !== "custom") {
			const map = official[cur].map;
			for (const l of LEVELS) {
				if (!(l in map)) continue;
				rows.append(h("div", { class: "tm-row" }, h("span", { class: "tm-lv" }, LEVEL_NAME[l]), h("span", { class: "tm-arrow", "aria-hidden": "true" }, "→"), h("code", {}, fmtParams(map[l]))));
			}
		} else {
			const t = m.thinkLevels;
			for (const l of LEVELS) {
				const on = l === "off" ? t.off !== null : t[l] != null;
				const txt = h("input", {
					type: "text",
					class: "mono",
					value: on ? JSON.stringify(t[l] || {}) : "",
					placeholder: l === "off" ? '关闭时发的参数，如 {"thinking":{"type":"disabled"}}，{} 为不发' : `如 {"reasoning_effort":"${l}"}`,
					disabled: !on,
					"aria-label": `${LEVEL_NAME[l]} 档请求参数（JSON）`,
					oninput: (e) => {
						try {
							const v = JSON.parse(e.target.value || "{}");
							if (!v || typeof v !== "object" || Array.isArray(v)) throw 0;
							t[l] = v;
							e.target.classList.remove("bad");
						} catch {
							e.target.classList.add("bad"); // 不合法时保留上次合法值
						}
					},
				});
				const chk = h("input", {
					type: "checkbox",
					checked: on,
					"aria-label": `支持 ${LEVEL_NAME[l]} 档`,
					onchange: (e) => {
						if (e.target.checked) t[l] = {};
						else if (l === "off") t.off = null;
						else delete t[l];
						render();
					},
				});
				rows.append(h("label", { class: "tm-row" }, chk, h("span", { class: "tm-lv" }, LEVEL_NAME[l]), h("span", { class: "tm-arrow", "aria-hidden": "true" }, "→"), txt));
			}
		}
		const hint = !S.state?.thinkOfficial
			? "服务端是旧版本，没有返回官方接口列表，请重启 ci 服务后刷新页面。"
			: cur === "custom"
				? "勾选支持的档位，并填写每档合并进请求体的 JSON 参数。对话框上方只显示勾上的档位。"
				: "官方接口的固定映射：对话里选某档，就把右边的参数合并进请求。其他接口请选“自定义”。";
		wrap.replaceChildren(pick, rows, h("span", { class: "hint" }, hint));
	};
	render();
	return wrap;
}

async function saveConfig() {
	try {
		cfgDraft = await api("/api/config", { method: "PUT", body: cfgDraft });
		await refreshState();
		toast("已保存");
		renderSettings();
	} catch (e) {
		toast(e.message, true);
	}
}

const TABS = {
	async models(body) {
		cfgDraft ||= await api("/api/config");
		const C = cfgDraft;
		const protoName = (p) => ({ anthropic: "Anthropic", gemini: "Gemini" })[p] || "OpenAI";
		// 内部 ID 自动生成：取名字里的英文数字，冲突时加序号；用户不用操心
		const makeId = (name, taken) => {
			const base = String(name).toLowerCase().replace(/[^a-z0-9.-]+/g, "-").replace(/^-+|-+$/g, "") || "item";
			let id = base;
			for (let i = 2; taken[id]; i++) id = `${base}-${i}`;
			return id;
		};
		for (const [pid, p] of Object.entries(C.providers)) {
			const models = Object.entries(C.models).filter(([, m]) => m.provider === pid);
			const card = h(
				"section",
				{ class: "card prov" },
				h(
					"div",
					{ class: "card-h" },
					h("span", { class: "title" }, p.name || pid),
					h("span", { class: "pill" }, protoName(p.protocol)),
					h("button", { class: "small ghost danger", type: "button", onclick: () => confirm(`删除供应商“${p.name || pid}”及其下 ${models.length} 个模型？`) && (models.forEach(([id]) => delete C.models[id]), delete C.providers[pid], saveConfig()) }, "删除供应商"),
				),
				h(
					"div",
					{ class: "grid" },
					field("名称", inp(p, "name")),
					field("协议", sel(p, "protocol", [["openai", "OpenAI 兼容"], ["anthropic", "Anthropic 兼容"], ["gemini", "Google Gemini"]], renderSettings)),
					field("Base URL", inp(p, "baseUrl", "text", { placeholder: { anthropic: "https://api.anthropic.com", gemini: "https://generativelanguage.googleapis.com" }[p.protocol] || "https://api.openai.com/v1" })),
					field("API Key", inp(p, "apiKey", "password", { autocomplete: "off", placeholder: "不需要可留空" })),
					p.protocol === "anthropic" ? field("认证方式", sel(p, "authStyle", [["x-api-key", "x-api-key"], ["bearer", "Bearer"]])) : null,
				),
			);
			const rows = h("div", { class: "rows model-rows" });
			for (const [id, m] of models) {
				const det = h(
					"details",
					{ class: "model-row" },
					h(
						"summary",
						{ class: "row-item" },
						h("span", { class: "c-name" }, m.name || id),
						h("span", { class: "c-main mono" }, m.model),
						h("span", { class: "c-meta" }, `${fmtK(m.contextWindow || 0)} 上下文`),
						C.defaultModel === id ? h("span", { class: "pill ready" }, "默认") : h("button", { class: "small ghost", type: "button", onclick: (e) => (e.preventDefault(), (C.defaultModel = id), saveConfig()) }, "设为默认"),
						h("button", { class: "small ghost danger", type: "button", onclick: (e) => (e.preventDefault(), confirm(`删除模型“${m.name || id}”？`) && (delete C.models[id], saveConfig())) }, "删除"),
					),
					h(
						"div",
						{ class: "row-edit grid" },
						field("显示名称", inp(m, "name")),
						field("模型 ID", inp(m, "model")),
						field("上下文长度", inp(m, "contextWindow", "number", { min: 1024 })),
						field("最大输出", inp(m, "maxOutput", "number", { min: 256 })),
						field("压缩阈值", inp(m, "compactAt", "number", { min: 1024 })),
						field("压缩时保留最近", inp(m, "keepRecent", "number", { min: 0 })),
						field("子代理并发", inp(m, "maxParallel", "number", { min: 1, max: 16 })),
						field("工具风格", sel(m, "toolStyle", [["native", "原生"], ["claude", "Claude Code"]])),
						h("div", { class: "field span-all" }, "思考档位", thinkEditor(m, id)),
					),
				);
				rows.append(det);
			}
			if (!models.length) rows.append(h("div", { class: "row-empty" }, "还没有模型"));
			const mid = h("input", { type: "text", placeholder: "模型 ID，如 gpt-4o、deepseek-chat", "aria-label": "新模型 ID" });
			const addModel = () => {
				const model = mid.value.trim();
				if (!model) return toast("请填写模型 ID", true);
				const id = makeId(model, C.models);
				C.models[id] = { name: model, provider: pid, model, contextWindow: 32768, maxOutput: 4096, compactAt: 24000, keepRecent: 8000, toolStyle: "native", maxParallel: 4 };
				renderSettings();
			};
			mid.addEventListener("keydown", (e) => e.key === "Enter" && (e.preventDefault(), addModel()));
			card.append(rows, h("div", { class: "rows-foot" }, mid, h("button", { type: "button", onclick: addModel }, "＋ 添加模型")));
			body.append(card);
		}
		const pname = h("input", { type: "text", placeholder: "供应商名称，如 DeepSeek", "aria-label": "新供应商名称" });
		const addProv = () => {
			const name = pname.value.trim();
			if (!name) return toast("请填写供应商名称", true);
			C.providers[makeId(name, C.providers)] = { name, protocol: "openai", baseUrl: "", apiKey: "" };
			renderSettings();
		};
		pname.addEventListener("keydown", (e) => e.key === "Enter" && (e.preventDefault(), addProv()));
		body.append(h("div", { class: "rows-foot sticky-foot" }, pname, h("button", { type: "button", onclick: addProv }, "＋ 添加供应商"), h("span", { class: "grow" }), h("button", { class: "primary", type: "button", onclick: saveConfig }, "保存")));
	},

	async skills(body) {
		const list = S.state.skills;
		const rows = h("div", { class: "rows" });
		if (!list.length) rows.append(h("div", { class: "row-empty" }, "还没有技能"));
		for (const s of list) {
			const editor = h("div", { class: "row-edit", hidden: true });
			const openEdit = async () => {
				if (!editor.hidden) return (editor.hidden = true);
				const { text } = await api("/api/skills/file" + q({ path: s.path })).catch((e) => (toast(e.message, true), {}));
				if (text == null) return;
				const ta = h("textarea", { class: "code-edit", spellcheck: "false", "aria-label": `${s.name} 的 SKILL.md` });
				ta.value = text;
				editor.replaceChildren(
					h("div", { class: "path" }, s.path),
					ta,
					h("div", { class: "actions" }, h("button", { type: "button", onclick: () => (editor.hidden = true) }, "取消"), h("button", { class: "primary", type: "button", onclick: () => api("/api/skills/file" + q({ path: s.path }), { method: "PUT", body: { text: ta.value } }).then(() => toast("已保存"), (e) => toast(e.message, true)) }, "保存")),
				);
				editor.hidden = false;
			};
			rows.append(
				h(
					"div",
					{ class: "row-item" },
					toggle(s.enabled, async (on) => {
						await api("/api/skills", { method: "PUT", body: { id: s.id, enabled: on } }).catch((e) => toast(e.message, true));
						toast(on ? `已启用 ${s.name}` : `已停用 ${s.name}`);
					}, `启用技能 ${s.name}`),
					h("span", { class: "c-name" }, s.name),
					h("span", { class: "pill" }, s.scope),
					h("span", { class: "c-main", title: s.description }, s.description),
					h("button", { class: "small ghost", type: "button", onclick: openEdit }, "编辑"),
					h("button", { class: "small ghost danger", type: "button", onclick: () => confirm(`删除技能“${s.name}”？会删除整个技能文件夹。`) && api("/api/skills/file" + q({ path: s.path }), { method: "DELETE" }).then(() => toast("已删除"), (e) => toast(e.message, true)) }, "删除"),
				),
				editor,
			);
		}
		// 新建
		const f = { name: "", description: "", scope: "global", body: "" };
		const bodyTa = h("textarea", { class: "code-edit small-edit", placeholder: "技能内容（Markdown）：做什么、步骤、注意事项", oninput: (e) => (f.body = e.target.value) });
		const form = h(
			"div",
			{ class: "row-edit", hidden: true },
			h("div", { class: "form-line" }, field("名称", inp(f, "name", "text", { placeholder: "如 git-commit" })), field("范围", sel(f, "scope", [["global", "全局"], ...(S.cwd ? [["project", "当前项目"]] : [])])), field("描述（模型据此判断何时使用）", inp(f, "description", "text", { placeholder: "用户要求提交代码时使用" }), null, "grow")),
			bodyTa,
			h("div", { class: "actions" }, h("button", { type: "button", onclick: () => (form.hidden = true) }, "取消"), h("button", { class: "primary", type: "button", onclick: () => api("/api/skills", { method: "POST", body: { ...f, cwd: S.cwd } }).then(() => toast(`已创建 ${f.name}`), (e) => toast(e.message, true)) }, "创建")),
		);
		body.append(rows, h("div", { class: "rows-foot" }, h("button", { type: "button", onclick: () => (form.hidden = !form.hidden) }, "＋ 新建技能")), form);
	},

	async mcp(body) {
		const statusText = { ready: "就绪", starting: "启动中", error: "出错", stopped: "已停用" };
		const { text } = await api("/api/mcp/raw");
		let cfg;
		try {
			cfg = JSON.parse(text || "{}");
		} catch {
			cfg = null;
		}
		const saveCfg = () => api("/api/mcp/raw", { method: "PUT", body: { text: JSON.stringify(cfg, null, "\t") + "\n" } }).then(() => toast("已保存，正在应用"), (e) => toast(e.message, true));
		const servers = cfg ? (cfg.mcpServers ||= {}) : {};
		const splitArgs = (s) => [...s.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]);
		const joinArgs = (a = []) => a.map((x) => (/\s/.test(x) ? `"${x}"` : x)).join(" ");
		const kv = (o = {}) => Object.entries(o).map(([k, v]) => `${k}=${v}`).join(" ");
		const parseKv = (s) => Object.fromEntries(splitArgs(s).map((x) => [x.slice(0, x.indexOf("=")), x.slice(x.indexOf("=") + 1)]).filter(([k]) => k));

		// 编辑表单：新建与修改共用
		const editForm = (name, c = {}) => {
			const f = { name, type: c.url ? "http" : "stdio", command: c.command || "", args: joinArgs(c.args), url: c.url || "", env: kv(c.env), headers: kv(c.headers), timeout: c.timeout ?? "" };
			const wrap = h("div", { class: "row-edit" });
			const draw = () => {
				const isHttp = f.type === "http";
				wrap.replaceChildren(
					h(
						"div",
						{ class: "form-line" },
						field("名称", inp(f, "name", "text", { placeholder: "如 playwright" })),
						field("类型", sel(f, "type", [["stdio", "本地命令"], ["http", "HTTP 地址"]], draw)),
						isHttp ? field("地址", inp(f, "url", "text", { placeholder: "https://…/mcp" }), null, "grow") : field("命令", inp(f, "command", "text", { placeholder: "npx" })),
						isHttp ? null : field("参数（空格分隔）", inp(f, "args", "text", { placeholder: "-y @playwright/mcp@latest" }), null, "grow"),
					),
					h(
						"div",
						{ class: "form-line" },
						isHttp ? field("请求头（K=V，空格分隔）", inp(f, "headers", "text", { placeholder: "Authorization=Bearer…" }), null, "grow") : field("环境变量（K=V，空格分隔）", inp(f, "env", "text", { placeholder: "API_KEY=…" }), null, "grow"),
						field("超时（秒）", inp(f, "timeout", "number", { placeholder: "300" })),
					),
					h(
						"div",
						{ class: "actions" },
						h("button", { type: "button", onclick: () => wrap.remove() }, "取消"),
						h("button", {
							class: "primary",
							type: "button",
							onclick: () => {
								const n = f.name.trim();
								if (!n) return toast("请填写名称", true);
								if (n !== name && servers[n]) return toast("名称已存在", true);
								const keep = name ? { enabled: c.enabled, alwaysLoad: c.alwaysLoad } : {};
								const next = isHttp ? { url: f.url.trim() } : { command: f.command.trim(), args: splitArgs(f.args) };
								const extra = isHttp ? (f.headers.trim() ? { headers: parseKv(f.headers) } : {}) : f.env.trim() ? { env: parseKv(f.env) } : {};
								if (name && name !== n) delete servers[name];
								servers[n] = { ...next, ...extra, ...(f.timeout !== "" && f.timeout != null ? { timeout: Number(f.timeout) } : {}), ...Object.fromEntries(Object.entries(keep).filter(([, v]) => v != null)) };
								saveCfg();
							},
						}, "保存"),
					),
				);
			};
			draw();
			return wrap;
		};

		const rows = h("div", { class: "rows" });
		const status = new Map(S.state.mcp.map((s) => [s.name, s]));
		const names = Object.keys(servers);
		if (!names.length) rows.append(h("div", { class: "row-empty" }, cfg ? "还没有 MCP 服务器" : "mcp.json 格式有误，请在下方直接修改"));
		for (const name of names) {
			const c = servers[name];
			const st = status.get(name) || { status: c.enabled === false ? "stopped" : "starting", tools: [] };
			const tools = h("div", { class: "row-edit", hidden: true }, h("ul", { class: "tool-list" }, ...st.tools.map((t) => h("li", {}, h("code", {}, t.name), h("span", {}, t.description || "")))));
			const row = h(
				"div",
				{ class: "row-item" },
				toggle(c.enabled !== false, (on) => api(`/api/mcp/${encodeURIComponent(name)}`, { method: "PUT", body: { enabled: on } }).catch((e) => toast(e.message, true)), `启用 MCP 服务器 ${name}`),
				h("span", { class: "c-name" }, name),
				h("span", { class: "pill" }, c.url ? "HTTP" : "本地"),
				h("span", { class: "c-main mono", title: c.url || `${c.command} ${joinArgs(c.args)}` }, c.url || `${c.command} ${joinArgs(c.args)}`),
				h("button", { class: `pill ${st.status} pill-btn`, type: "button", title: st.error || "查看工具", onclick: () => (tools.hidden = !tools.hidden) }, statusText[st.status] || st.status, st.status === "ready" ? ` · ${st.tools.length}` : ""),
				h("label", { class: "chk", title: "始终把这个服务器的工具直接发给模型（不经过搜索工具）" }, h("input", { type: "checkbox", checked: !!c.alwaysLoad, onchange: (e) => ((c.alwaysLoad = e.target.checked || undefined), saveCfg()) }), "始终加载"),
				h("button", { class: "small ghost", type: "button", onclick: () => row.after(editForm(name, c)) }, "编辑"),
				h("button", { class: "small ghost danger", type: "button", onclick: () => confirm(`删除 MCP 服务器“${name}”？`) && (delete servers[name], saveCfg()) }, "删除"),
			);
			rows.append(row);
			if (st.error) rows.append(h("div", { class: "row-err" }, st.error));
			rows.append(tools);
		}
		const raw = h("textarea", { class: "code-edit", spellcheck: "false", "aria-label": "mcp.json 内容" });
		raw.value = text;
		body.append(
			rows,
			h("div", { class: "rows-foot" }, h("button", { type: "button", disabled: !cfg, onclick: (e) => e.target.parentElement.after(editForm("", {})) }, "＋ 添加服务器")),
			h("details", { class: "raw" }, h("summary", {}, "mcp.json"), raw, h("div", { class: "actions" }, h("button", { class: "primary", type: "button", onclick: () => api("/api/mcp/raw", { method: "PUT", body: { text: raw.value } }).then(() => toast("已保存，正在应用"), (e) => toast(e.message, true)) }, "保存"))),
		);
	},
};

async function renderSettings() {
	if (!settingsTab) return;
	for (const b of document.querySelectorAll(".tabs button")) b.setAttribute("aria-selected", b.dataset.tab === settingsTab);
	const body = $("#settings-body");
	const scroll = body.scrollTop;
	const frag = h("div");
	try {
		await TABS[settingsTab](frag);
	} catch (e) {
		frag.append(h("p", { class: "desc", style: "color:var(--err)" }, e.message));
	}
	body.replaceChildren(...frag.childNodes);
	body.scrollTop = scroll;
}
$("#settings-btn").onclick = async () => {
	cfgDraft = null;
	settingsTab = "models";
	await refreshState();
	renderSettings();
	$("#settings-dialog").showModal();
};
$("#settings-close").onclick = () => $("#settings-dialog").close();
$("#settings-dialog").addEventListener("close", () => (settingsTab = null));
for (const b of document.querySelectorAll(".tabs button"))
	b.onclick = () => {
		settingsTab = b.dataset.tab;
		renderSettings();
	};

// ───────────── 启动 ─────────────
(async () => {
	if (!S.token) {
		box().replaceChildren(h("div", { class: "empty" }, emptyLogo(), h("p", {}, "缺少访问令牌。请使用服务启动时终端里输出的地址打开。")));
		return;
	}
	try {
		await refreshState();
	} catch (e) {
		box().replaceChildren(h("div", { class: "empty" }, emptyLogo(), h("p", {}, e.message)));
		return;
	}
	connectEvents();
	renderSidebar(); // 先画缓存，再向服务刷新
	await loadTree();
	const last = S.cwd && localStorage.getItem("ci.session." + S.cwd);
	if (last && S.tree.some((p) => samePath(p.path, S.cwd) && p.sessions.some((x) => x.id === last))) await openSession(S.cwd, last);
	else clearView();
})();
