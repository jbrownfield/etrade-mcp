#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import dotenv from "dotenv";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ToolSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { assertReadonlyRuntime } from "./readonly-runtime.js";
import { readReadonlyConfig } from "./readonly-config.js";
import { buildReadonlyEnvironment } from "./readonly-policy.js";
import { readSecureMount } from "./secure-mount.js";
import { withInitializationDeadline } from "./initialization-deadline.js";
import { createLazyServer } from "./lazy-server.js";
import catalog from "./readonly-tool-catalog.json";

const version: string = JSON.parse(
	readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;
const argv = process.argv.slice(2);
if (argv.length === 1 && ["--help", "-h"].includes(argv[0])) {
	console.log(
		"Usage: etrade-mcp-readonly --config <path>\n\nNode 22+, macOS/Linux. Read-only MCP with on-demand credentials from a FIFO.\nConfiguration: environment, credentialMount, accountIdKey.\nUse an absolute config path in your MCP client. See docs/readonly-launcher.md.",
	);
	process.exit(0);
}
if (argv.length === 1 && ["--version", "-v"].includes(argv[0])) {
	console.log(version);
	process.exit(0);
}
try {
	assertReadonlyRuntime(process.versions, process.platform);
} catch (error) {
	console.error((error as Error).message);
	process.exit(1);
}
if (argv.length !== 2 || argv[0] !== "--config" || !argv[1]) {
	console.error("Usage: etrade-mcp-readonly --config <path>");
	process.exit(1);
}

async function main() {
	const config = readReadonlyConfig(argv[1]);
	const home = homedir();
	if (!home) throw Error("No home");
	const tools: Tool[] = catalog.map((tool) => ToolSchema.parse(tool));
	type Entry = {
		client: Client;
		transport?: StdioClientTransport;
		pid?: number;
		closing?: Promise<void>;
	};
	const backends = new Set<Entry>();
	let stopping = false;
	const schemas = (list: Tool[]) =>
		list
			.map(({ name, inputSchema }) => ({ name, inputSchema }))
			.sort((a, b) => a.name.localeCompare(b.name));
	const server = createLazyServer(
		tools,
		(parentSignal) =>
			withInitializationDeadline(parentSignal, async (signal) => {
				signal.throwIfAborted();
				if (stopping) throw Error("Closing");
				const payload = await readSecureMount(config.credentialMount, { signal });
				let env: Record<string, string>;
				try {
					env = buildReadonlyEnvironment(config, dotenv.parse(payload), home);
				} finally {
					payload.fill(0);
				}
				signal.throwIfAborted();
				if (stopping) throw Error("Closing");
				const client = new Client({ name: "etrade-mcp-readonly-launcher", version });
				const entry: Entry = { client };
				const close = client.close.bind(client);
				// SDK connect may start close internally; every caller must await the original close.
				client.close = () =>
					(entry.closing ??= (async () => {
						entry.pid ??= entry.transport?.pid ?? undefined;
						await close();
					})());
				backends.add(entry);
				client.onclose = () => backends.delete(entry);
				try {
					entry.transport = new StdioClientTransport({
						command: process.execPath,
						args: [fileURLToPath(new URL("./mcp.js", import.meta.url))],
						cwd: home,
						env,
						stderr: "ignore",
					});
					await client.connect(entry.transport, { signal });
					signal.throwIfAborted();
					const live = await client.listTools(undefined, { signal });
					if (live.nextCursor || !isDeepStrictEqual(schemas(live.tools), schemas(tools)))
						throw Error("Catalog mismatch");
					return client;
				} catch {
					await client.close();
					backends.delete(entry);
					throw Error("Backend unavailable");
				}
			}),
		version,
	);
	async function shutdown() {
		if (stopping) return;
		stopping = true;
		server.abortPending();
		const timer = setTimeout(() => {
			for (const entry of backends) {
				const pid = entry.pid ?? entry.transport?.pid;
				if (pid) {
					try {
						process.kill(pid, "SIGKILL");
					} catch {}
				}
			}
			process.exit(0);
		}, 6000);
		timer.unref();
		await Promise.allSettled([...backends].map((entry) => entry.client.close()));
		try {
			await server.close();
		} finally {
			process.exit(0);
		}
	}
	server.onclose = () => {
		void shutdown();
	};
	process.stdin.on("end", () => {
		void shutdown();
	});
	process.stdin.on("close", () => {
		void shutdown();
	});
	process.on("SIGINT", () => {
		void shutdown();
	});
	process.on("SIGTERM", () => {
		void shutdown();
	});
	await server.connect(new StdioServerTransport());
}
main().catch(() => {
	console.error("Read-only launcher could not start. Check its configuration and installation.");
	process.exitCode = 1;
});
