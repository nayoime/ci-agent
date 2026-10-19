import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findShell, truncate, IS_WIN } from "./util.js";

// Git Bash（MSYS）派生的子进程在 Windows 进程树里是断开的，taskkill /T 杀不全。
// 所以命令开头先记下 shell 自己的 MSYS pid，停止时用 /proc 按会话找出全部进程一起杀。
const MSYS_KILL = [
	// Node 启动的 bash 自成一个会话（sid = 它自己的 pid）；同会话的进程（含后台、孤儿）全部杀掉
	"sid=$(cat /proc/$1/sid 2>/dev/null) || exit 0",
	// 保险：会话不是它自己开的（极少见）就只杀它的进程组，免得误杀别的程序
	"[ \"$sid\" = \"$1\" ] || { kill -9 -- -$1 $1 2>/dev/null; exit 0; }",
	"list=",
	"for d in /proc/[0-9]*; do [ \"$(cat $d/sid 2>/dev/null)\" = \"$sid\" ] && list=\"$list ${d#/proc/}\"; done",
	"[ -n \"$list\" ] && kill -9 $list 2>/dev/null",
	"exit 0",
].join("\n");

function killTree(child, shell, pidFile) {
	if (!child.pid) return;
	if (IS_WIN) {
		let msysPid = "";
		try {
			msysPid = fs.readFileSync(pidFile, "utf8").trim();
		} catch {}
		if (/^\d+$/.test(msysPid)) spawnSync(shell, ["-c", MSYS_KILL, "kill", msysPid], { stdio: "ignore", windowsHide: true, timeout: 5000 });
		spawnSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore", windowsHide: true });
	} else {
		try {
			process.kill(-child.pid, "SIGKILL");
		} catch {
			child.kill("SIGKILL");
		}
	}
}

export default {
	name: "bash",
	label: "执行命令",
	description: "在工作目录执行 bash 命令，返回 stdout 和 stderr。",
	parameters: {
		type: "object",
		properties: {
			command: { type: "string", description: "要执行的命令" },
			timeout: { type: "number", description: "超时秒数，默认 120，最大 600" },
		},
		required: ["command"],
	},
	claude: {
		name: "Bash",
		parameters: {
			type: "object",
			properties: {
				command: { type: "string", description: "要执行的命令" },
				timeout: { type: "number", description: "超时毫秒数，默认 120000，最大 600000" },
				description: { type: "string", description: "用 5~10 个字描述命令用途" },
			},
			required: ["command"],
		},
		toWire: (a) => ({ command: a.command, ...(a.timeout ? { timeout: a.timeout * 1000 } : {}) }),
	},
	normalize(a) {
		let timeout = a.timeout;
		if (typeof timeout === "string") timeout = Number(timeout);
		if (typeof timeout === "number" && timeout > 1000) timeout = Math.ceil(timeout / 1000); // 毫秒 → 秒
		return { command: a.command ?? a.cmd ?? a.script, timeout };
	},

	/** 界面显示的时长上限（秒） */
	limit: (a) => Math.min(Math.max(Number(a?.timeout) || 120, 1), 600),

	run({ command, timeout = 120 }, ctx) {
		if (!command || typeof command !== "string") throw new Error("command 不能为空");
		const secs = Math.min(Math.max(Number(timeout) || 120, 1), 600);
		const shell = findShell(ctx.settings?.shell);
		const isPwsh = /powershell|pwsh/i.test(shell);
		const pidFile = path.join(os.tmpdir(), `ci-bash-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.pid`).replace(/\\/g, "/");
		// bash：第一行把自己的 pid 写进临时文件，供停止时找后代
		const args = isPwsh ? ["-NoProfile", "-Command", command] : ["-c", `echo $$ > '${pidFile}'\n${command}`];

		return new Promise((resolve, reject) => {
			const child = spawn(shell, args, {
				cwd: ctx.cwd,
				env: { ...process.env, CI_AGENT: "1", PAGER: "cat", GIT_PAGER: "cat" },
				detached: !IS_WIN,
				// 不给标准输入：等输入的交互命令会立即读到 EOF，而不是一直卡到超时
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			});
			const chunks = [];
			let size = 0;
			const onData = (d) => {
				chunks.push(d);
				size += d.length;
				// 内存保护：只保留最近 ~1MB
				while (size > 1024 * 1024 && chunks.length > 1) size -= chunks.shift().length;
				ctx.onUpdate?.(d.toString());
			};
			child.stdout.on("data", onData);
			child.stderr.on("data", onData);

			let timedOut = false;
			let done = false;
			const finish = (code) => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				fs.rm(pidFile, { force: true }, () => {});
				ctx.signal?.removeEventListener("abort", onAbort);
				let out = truncate(Buffer.concat(chunks).toString("utf8"), { mode: "tail" }).trimEnd();
				const note = (t) => (out = out ? out + "\n\n" + t : t);
				if (ctx.signal?.aborted) note("（用户手动停止了这个命令）");
				else if (timedOut) note(`（超时 ${secs} 秒，已终止）`);
				else if (code !== 0) note(`退出码：${code}`);
				resolve({ content: out || "（无输出）", isError: timedOut || !!ctx.signal?.aborted || (code !== 0 && code !== null), details: { exitCode: code } });
			};
			// 终止后最多再等 1 秒：残留进程占着输出管道时不再干等
			const kill = () => {
				killTree(child, shell, pidFile);
				setTimeout(() => {
					child.stdout.destroy();
					child.stderr.destroy();
					finish(null);
				}, 1000);
			};
			const timer = setTimeout(() => {
				timedOut = true;
				kill();
			}, secs * 1000);
			const onAbort = () => kill();
			ctx.signal?.addEventListener("abort", onAbort, { once: true });

			child.on("error", (e) => {
				clearTimeout(timer);
				done = true;
				reject(new Error(`无法启动 shell（${shell}）：${e.message}`));
			});
			child.on("close", finish);
		});
	},
};
