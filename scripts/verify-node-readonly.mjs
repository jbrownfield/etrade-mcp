/** Built-package checks: only dummy credentials, temporary homes and simulated broker processes. */
import assert from "node:assert/strict";
import {
	mkdtempSync,
	rmSync,
	mkdirSync,
	writeFileSync,
	readFileSync,
	copyFileSync,
	existsSync,
	symlinkSync,
	openSync,
	writeSync,
	closeSync,
	constants,
} from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
assert.ok(existsSync(join(dist, "mcp-readonly.js")), "Build first: missing dist/mcp-readonly.js");
const catalog = JSON.parse(readFileSync(join(root, "src/readonly-tool-catalog.json"), "utf8"));
const expected = [
	"etrade_get_balance",
	"etrade_get_portfolio",
	"etrade_get_transaction",
	"etrade_list_accounts",
	"etrade_list_orders",
	"etrade_list_transactions",
	"etrade_snapshot",
];
const schemas = (tools) =>
	tools
		.map(({ name, inputSchema }) => ({ name, inputSchema }))
		.sort((a, b) => a.name.localeCompare(b.name));
const temp = mkdtempSync(join(tmpdir(), "readonly package "));
const home = join(temp, "other home");
mkdirSync(home);
const key = Buffer.alloc(32, 7).toString("base64");
const payload = `ETRADE_SANDBOX_API_KEY=dummy\nETRADE_SANDBOX_API_KEY_SECRET=dummy-secret\nETRADE_TOKEN_ENCRYPTION_KEY=${key}\nETRADE_ALLOW_ORDERS=1\nNODE_OPTIONS=--inspect\n`;
const children = new Set();
const backendPids = new Set();
const rememberPid = (pid) => {
	backendPids.add(pid);
	return pid;
};
async function until(fn, timeout = 3000) {
	const end = Date.now() + timeout;
	while (!fn()) {
		if (Date.now() > end) throw Error("condition timed out");
		await delay(10);
	}
}
function session(entry, args = [], extra = {}) {
	const child = spawn(process.execPath, [entry, ...args], {
		cwd: home,
		env: { PATH: process.env.PATH, HOME: home, ...extra },
		stdio: ["pipe", "pipe", "pipe"],
	});
	children.add(child);
	let stderr = "";
	child.stderr.on("data", (b) => (stderr += b));
	const exited = new Promise((resolve) =>
		child.on("exit", (code) => {
			children.delete(child);
			resolve(code);
		}),
	);
	const pending = new Map();
	let seq = 0;
	const lines = createInterface({ input: child.stdout });
	lines.on("line", (line) => {
		const message = JSON.parse(line);
		if (message.id !== undefined) {
			const slot = pending.get(message.id);
			if (slot) {
				clearTimeout(slot.timer);
				pending.delete(message.id);
				message.error
					? slot.reject(Error(JSON.stringify(message.error)))
					: slot.resolve(message.result);
			}
		}
	});
	const send = (message) => child.stdin.write(JSON.stringify(message) + "\n");
	function start(method, params = {}) {
		const id = ++seq;
		const promise = new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				pending.delete(id);
				reject(Error("request timeout: " + method + " in " + entry + " stderr: " + stderr));
			}, 8000);
			pending.set(id, { resolve, reject, timer });
		});
		send({ jsonrpc: "2.0", id, method, params });
		return { id, promise };
	}
	return {
		child,
		start,
		send,
		exited,
		stderr: () => stderr,
		async init() {
			await start("initialize", {
				protocolVersion: "2024-11-05",
				capabilities: {},
				clientInfo: { name: "offline-test", version: "1" },
			}).promise;
			send({ jsonrpc: "2.0", method: "notifications/initialized" });
		},
		async close() {
			child.stdin.end();
			await until(() => child.exitCode !== null || child.signalCode !== null, 7500);
			assert.equal(await exited, 0);
			for (const { timer, reject } of pending.values()) {
				clearTimeout(timer);
				reject(Error("closed"));
			}
			pending.clear();
			lines.close();
		},
	};
}
async function feed(path, value = payload) {
	const end = Date.now() + 3000;
	while (true) {
		let fd;
		try {
			fd = openSync(path, constants.O_WRONLY | constants.O_NONBLOCK);
		} catch (e) {
			if (e.code !== "ENXIO" || Date.now() > end) throw e;
			await delay(10);
			continue;
		}
		try {
			writeSync(fd, value);
		} finally {
			closeSync(fd);
		}
		return;
	}
}
function alive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
try {
	for (const flag of ["--help", "--version"]) {
		const text = execFileSync(process.execPath, [join(dist, "mcp-readonly.js"), flag], {
			cwd: home,
			env: { HOME: home },
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		assert.ok(text.trim());
	}
	// Actual packaged backend must advertise only the expected read operations.
	const real = session(join(dist, "mcp.js"), [], {
		ETRADE_ENV: "sandbox",
		ETRADE_ALLOW_ORDERS: "0",
		ETRADE_LOAD_DOTENV: "0",
		ETRADE_SANDBOX_API_KEY: "dummy",
		ETRADE_SANDBOX_API_KEY_SECRET: "dummy",
	});
	await real.init();
	const live = await real.start("tools/list").promise;
	assert.deepEqual(live.tools.map((t) => t.name).sort(), expected);
	assert.deepEqual(schemas(live.tools), schemas(catalog));
	await real.close();
	if (!["darwin", "linux"].includes(process.platform)) {
		console.log("Catalog verified; FIFO integration unsupported on this platform.");
		process.exitCode = 0;
	} else {
		// Copy installed bundle to an unrelated directory. Only the backend is replaced with a controllable mock.
		const packageDir = join(temp, "installed package");
		mkdirSync(packageDir);
		mkdirSync(join(packageDir, "dist"));
		copyFileSync(join(dist, "mcp-readonly.js"), join(packageDir, "dist/mcp-readonly.js"));
		writeFileSync(
			join(packageDir, "package.json"),
			JSON.stringify({ type: "module", version: "1.0.0" }),
		);
		symlinkSync(join(root, "node_modules"), join(packageDir, "node_modules"), "dir");
		const pipe = join(home, "credentials.pipe");
		execFileSync("mkfifo", ["-m", "600", pipe]);
		const config = join(home, "settings.private.json");
		writeFileSync(
			config,
			JSON.stringify({
				environment: "sandbox",
				credentialMount: "credentials.pipe",
				accountIdKey: "dummy-account",
			}),
		);
		const pidFile = join(home, "backend.pid");
		const marker = join(home, "preload-ran");
		const backend = join(packageDir, "dist/mcp.js");
		function mock(stubborn = false) {
			writeFileSync(
				backend,
				`import fs from 'node:fs';import readline from 'node:readline';fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));\n${stubborn ? "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);process.stdin.resume();" : `const tools=${JSON.stringify(catalog)};readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;let result;if(m.method==='initialize')result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'mock',version:'1'}};else if(m.method==='tools/list')result={tools};else if(m.method==='tools/call')result={content:[{type:'text',text:JSON.stringify({orders:process.env.ETRADE_ALLOW_ORDERS,account:process.env.ETRADE_ALLOWED_ACCOUNT_IDS,key:process.env.ETRADE_SANDBOX_API_KEY,nodeOptions:process.env.NODE_OPTIONS,home:process.env.HOME})}]};else result={};console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result}));});process.stdin.on('end',()=>process.exit(0));`}`,
			);
		}
		mock();
		const preload = join(home, "preload.cjs");
		writeFileSync(
			preload,
			`if(process.argv[1].endsWith('/mcp.js'))require('fs').writeFileSync(${JSON.stringify(marker)},'bad');`,
		);
		writeFileSync(join(home, ".env"), "ETRADE_ALLOW_ORDERS=1\nETRADE_SANDBOX_API_KEY=poison\n");
		const entry = join(packageDir, "dist/mcp-readonly.js");
		const s = session(entry, ["--config", config], {
			ETRADE_ALLOW_ORDERS: "1",
			ETRADE_ALLOWED_ACCOUNT_IDS: "other",
			ETRADE_SANDBOX_API_KEY: "poison",
			NODE_OPTIONS: `--require ${JSON.stringify(preload)}`,
		});
		await s.init();
		await s.start("ping").promise;
		assert.equal((await s.start("tools/list").promise).tools.length, 7);
		assert.equal(existsSync(pidFile), false);
		assert.throws(() => openSync(pipe, constants.O_WRONLY | constants.O_NONBLOCK), {
			code: "ENXIO",
		});
		const invalid = await s.start("tools/call", {
			name: "etrade_get_balance",
			arguments: { accountIdKey: 17 },
		}).promise;
		assert.equal(invalid.isError, true);
		assert.equal(existsSync(pidFile), false);
		const failed = s.start("tools/call", { name: "etrade_list_accounts" });
		await feed(pipe, "ETRADE_SANDBOX_API_KEY=PRIVATE_DUMMY\n");
		const failure = await failed.promise;
		assert.equal(failure.isError, true);
		assert.equal(JSON.stringify(failure).includes("PRIVATE_DUMMY"), false);
		assert.equal(existsSync(pidFile), false);
		const call = s.start("tools/call", { name: "etrade_list_accounts" });
		await feed(pipe);
		const answer = await call.promise;
		const observed = JSON.parse(answer.content[0].text);
		assert.deepEqual(observed, { orders: "0", account: "dummy-account", key: "dummy", home });
		assert.equal(existsSync(marker), false);
		const firstPid = rememberPid(Number(readFileSync(pidFile, "utf8")));
		process.kill(firstPid, "SIGKILL");
		await until(() => !alive(firstPid));
		await delay(40);
		rmSync(pidFile);
		await s.start("tools/list").promise;
		assert.equal(existsSync(pidFile), false);
		const retry = s.start("tools/call", { name: "etrade_list_accounts" });
		await feed(pipe);
		assert.ok(!(await retry.promise).isError);
		const secondPid = rememberPid(Number(readFileSync(pidFile, "utf8")));
		await s.close();
		await until(() => !alive(secondPid));
		assert.equal(s.stderr(), "");
		// Connect cancellation causes SDK internal close; simultaneous EOF must await that same close.
		rmSync(pidFile);
		mock(true);
		const stubborn = session(entry, ["--config", config]);
		await stubborn.init();
		const pending = stubborn.start("tools/call", { name: "etrade_list_accounts" });
		pending.promise.catch(() => {});
		await feed(pipe);
		await until(() => existsSync(pidFile));
		const stubbornPid = rememberPid(Number(readFileSync(pidFile, "utf8")));
		stubborn.send({
			jsonrpc: "2.0",
			method: "notifications/cancelled",
			params: { requestId: pending.id, reason: "test" },
		});
		await delay(30);
		await stubborn.close();
		await until(() => !alive(stubbornPid));
		assert.equal(stubborn.stderr(), "");
		// Verify the actual idle backend sees EOF if its launcher dies without cleanup.
		copyFileSync(join(dist, "mcp.js"), backend);
		const hardKilled = session(entry, ["--config", config]);
		await hardKilled.init();
		const denied = hardKilled.start("tools/call", { name: "etrade_list_accounts" });
		await feed(pipe);
		assert.equal((await denied.promise).isError, true); // no token exists, so no broker request
		const processRows = execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" });
		const realPids = processRows
			.trim()
			.split("\n")
			.map((line) => line.trim().split(/\s+/).map(Number))
			.filter(([, parent]) => parent === hardKilled.child.pid)
			.map(([pid]) => pid);
		assert.equal(realPids.length, 1);
		rememberPid(realPids[0]);
		hardKilled.child.kill("SIGKILL");
		await hardKilled.exited;
		await until(() => !alive(realPids[0]));
		console.log(
			"PASS: catalog, installed paths, lazy discovery, policy isolation, reconnect, EOF and stubborn-child cancellation.",
		);
	}
} finally {
	for (const child of children) {
		child.kill("SIGKILL");
	}
	for (const pid of backendPids) {
		if (alive(pid)) process.kill(pid, "SIGKILL");
	}
	const pidPath = join(home, "backend.pid");
	if (existsSync(pidPath)) {
		const pid = Number(readFileSync(pidPath, "utf8"));
		if (alive(pid)) process.kill(pid, "SIGKILL");
	}
	rmSync(temp, { recursive: true, force: true });
}
