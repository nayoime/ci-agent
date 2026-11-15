// 通用 SSE 解析：逐个产出 { event, data }
export async function* readSSE(response, signal) {
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buf = "";
	try {
		while (true) {
			if (signal?.aborted) throw abortError();
			const { done, value } = await reader.read();
			if (done) break;
			signal?.touch?.(); // 空闲看门狗重新计时（protocol/index.js）
			buf += decoder.decode(value, { stream: true });
			let m;
			while ((m = /\r?\n\r?\n/.exec(buf))) {
				const raw = buf.slice(0, m.index);
				buf = buf.slice(m.index + m[0].length);
				const evt = parseEvent(raw);
				if (evt) yield evt;
			}
		}
		const evt = parseEvent(buf);
		if (evt) yield evt;
	} finally {
		reader.releaseLock?.();
	}
}

function parseEvent(raw) {
	let event = "message";
	const data = [];
	for (const line of raw.split(/\r?\n/)) {
		if (line.startsWith("event:")) event = line.slice(6).trim();
		else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
	}
	if (!data.length) return null;
	return { event, data: data.join("\n") };
}

export function abortError() {
	const e = new Error("已中止");
	e.name = "AbortError";
	return e;
}

/** 统一 HTTP 错误；识别上下文超长，便于上层压缩重试 */
export async function httpError(res) {
	const body = await res.text().catch(() => "");
	const e = new Error(`HTTP ${res.status}：${body.slice(0, 800)}`);
	e.status = res.status;
	if (/context|too long|exceed|maximum.*tokens|prompt is too long/i.test(body) && res.status === 400) {
		e.code = "context_overflow";
	}
	return e;
}
