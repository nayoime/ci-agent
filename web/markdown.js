// 极简 Markdown 渲染：先整体转义 HTML，再处理语法，杜绝注入
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function inline(s) {
	const codes = [];
	s = s.replace(/`([^`\n]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
	s = s
		.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
		.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>")
		.replace(/~~([^~\n]+)~~/g, "<del>$1</del>")
		.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
		.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
	return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
}

/**
 * 数学公式：渲染前把 $$…$$、\[…\]、$…$、\(…\) 换成占位符（代码块和行内代码里的不动），
 * Markdown 处理完再用 KaTeX（web/vendor/katex，本地加载）替换回去。KaTeX 没加载时原样显示
 */
const MATH_RE = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$(?![\s$])((?:\\\$|[^$\n])+?)(?<![\s\\])\$(?!\d)/g;
// 代码：``` 围栏块（未闭合时到结尾）或 `行内代码`，里面的 $ 不当公式
const CODE_RE = /(^[ \t]*```[\s\S]*?(?:^[ \t]*```[ \t]*$|(?![\s\S]))|`[^`\n]+`)/m;
function extractMath(src, store) {
	return src
		.split(new RegExp(CODE_RE.source, "gm"))
		.map((seg, i) =>
			i % 2
				? seg
				: seg.replace(MATH_RE, (all, d1, d2, i1, i2) => {
						store.push({ tex: d1 ?? d2 ?? i1 ?? i2, display: d1 != null || d2 != null, raw: all });
						return `\u0001${store.length - 1}\u0001`;
					}),
		)
		.join("");
}
function renderMath({ tex, display, raw }) {
	const k = globalThis.katex;
	if (!k) return esc(raw);
	try {
		return k.renderToString(tex.trim(), { displayMode: display, throwOnError: false, output: "htmlAndMathml" });
	} catch {
		return esc(raw);
	}
}

export function renderMarkdown(src) {
	const math = [];
	return renderBlocks(extractMath(String(src ?? ""), math)).replace(/\u0001(\d+)\u0001/g, (_, i) => renderMath(math[i]));
}

function renderBlocks(src) {
	const lines = esc(src).split("\n");
	const out = [];
	let i = 0;
	let para = [];
	const flush = () => {
		if (para.length) out.push(`<p>${inline(para.join("<br>"))}</p>`);
		para = [];
	};

	while (i < lines.length) {
		const line = lines[i];
		let m;
		if ((m = /^\s*```\s*([\w+-]*)/.exec(line))) {
			flush();
			const lang = m[1];
			const buf = [];
			i++;
			while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) buf.push(lines[i++]);
			i++;
			out.push(
				`<div class="code"><div class="code-head"><span>${lang || "代码"}</span><button class="copy" type="button" aria-label="复制代码">复制</button></div><pre><code>${buf.join("\n")}</code></pre></div>`,
			);
			continue;
		}
		if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
			flush();
			const lv = Math.min(m[1].length + 2, 6);
			out.push(`<h${lv}>${inline(m[2])}</h${lv}>`);
			i++;
			continue;
		}
		if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
			flush();
			out.push("<hr>");
			i++;
			continue;
		}
		if (/^\s*&gt;\s?/.test(line)) {
			flush();
			const buf = [];
			while (i < lines.length && /^\s*&gt;\s?/.test(lines[i])) buf.push(lines[i++].replace(/^\s*&gt;\s?/, ""));
			out.push(`<blockquote>${inline(buf.join("<br>"))}</blockquote>`);
			continue;
		}
		if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] || "")) {
			flush();
			const cells = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => inline(c.trim()));
			const head = cells(line);
			i += 2;
			const rows = [];
			while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
			out.push(
				`<div class="table"><table><thead><tr>${head.map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>${rows
					.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`)
					.join("")}</tbody></table></div>`,
			);
			continue;
		}
		if ((m = /^(\s*)([-*+]|\d+[.)])\s+/.exec(line))) {
			flush();
			const ordered = /\d/.test(m[2]);
			const items = [];
			while (i < lines.length && (m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]))) {
				let text = m[3];
				i++;
				while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) text += "<br>" + lines[i++].trim();
				items.push(`<li${m[1].length >= 2 ? ' class="nested"' : ""}>${inline(text)}</li>`);
			}
			out.push(ordered ? `<ol>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`);
			continue;
		}
		if (!line.trim()) {
			flush();
			i++;
			continue;
		}
		para.push(line);
		i++;
	}
	flush();
	return out.join("");
}

export { esc };
