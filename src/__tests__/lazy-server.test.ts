import { test } from "bun:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createLazyServer, type Backend } from "../lazy-server.js";
import type { Tool, CallToolRequest } from "@modelcontextprotocol/sdk/types.js";
const tools: Tool[] = [
	{
		name: "etrade_list_accounts",
		description: "Read accounts",
		inputSchema: { type: "object", properties: {} },
	},
];
async function setup(connect: (signal: AbortSignal) => Promise<Backend>) {
	const server = createLazyServer(tools, connect);
	const client = new Client({ name: "test", version: "1" });
	const [a, b] = InMemoryTransport.createLinkedPair();
	await server.connect(a);
	await client.connect(b);
	return {
		client,
		close: async () => {
			await client.close();
			await server.close();
		},
	};
}
test("initialization, ping, and tool discovery never request credentials", async () => {
	let reads = 0;
	const x = await setup(async () => {
		reads++;
		throw Error("must not read");
	});
	try {
		await x.client.ping();
		assert.equal((await x.client.listTools()).tools.length, 1);
		assert.equal(reads, 0);
	} finally {
		await x.close();
	}
});
test("concurrent tool calls share one lazy initialization and preserve results", async () => {
	let reads = 0;
	const x = await setup(async () => {
		reads++;
		await new Promise((r) => setTimeout(r, 15));
		return { callTool: async () => ({ content: [{ type: "text", text: "dummy account" }] }) };
	});
	try {
		const result = await Promise.all([
			x.client.callTool({ name: "etrade_list_accounts", arguments: {} }),
			x.client.callTool({ name: "etrade_list_accounts", arguments: {} }),
		]);
		assert.equal(reads, 1);
		assert.ok(Array.isArray(result[0].content));
		assert.equal(result[0].content[0].text, "dummy account");
	} finally {
		await x.close();
	}
});
test("unknown tool never reads credentials", async () => {
	let reads = 0;
	const x = await setup(async () => {
		reads++;
		throw Error("must not connect");
	});
	try {
		const result = await x.client.callTool({ name: "etrade_place_order", arguments: {} });
		assert.equal(result.isError, true);
		assert.equal(reads, 0);
	} finally {
		await x.close();
	}
});
test("initialization failures are redacted and retried only on another call", async () => {
	let reads = 0;
	const x = await setup(async () => {
		reads++;
		throw Error("SECRET");
	});
	try {
		const result = await x.client.callTool({ name: "etrade_list_accounts", arguments: {} });
		assert.equal(result.isError, true);
		assert.ok(!JSON.stringify(result).includes("SECRET"));
		await x.client.listTools();
		assert.equal(reads, 1);
		await x.client.callTool({ name: "etrade_list_accounts", arguments: {} });
		assert.equal(reads, 2);
	} finally {
		await x.close();
	}
});
test("cancelled requests never dispatch after credential approval", async () => {
	let release!: () => void;
	let calls = 0;
	const ready = new Promise<void>((r) => {
		release = r;
	});
	const x = await setup(async () => {
		await ready;
		return {
			callTool: async () => {
				calls++;
				return { content: [] };
			},
		};
	});
	try {
		const controller = new AbortController();
		const request = x.client.callTool({ name: "etrade_list_accounts", arguments: {} }, undefined, {
			signal: controller.signal,
		});
		await new Promise((r) => setTimeout(r, 10));
		controller.abort();
		await assert.rejects(request);
		await new Promise((r) => setTimeout(r, 10));
		release();
		await new Promise((r) => setTimeout(r, 20));
		assert.equal(calls, 0);
	} finally {
		await x.close();
	}
});
test("tool error results do not disclose backend error text", async () => {
	const x = await setup(async () => ({
		callTool: async () => ({ isError: true, content: [{ type: "text", text: "SECRET" }] }),
	}));
	try {
		const r = await x.client.callTool({ name: "etrade_list_accounts", arguments: {} });
		assert.equal(r.isError, true);
		assert.ok(!JSON.stringify(r).includes("SECRET"));
	} finally {
		await x.close();
	}
});
test("malformed arguments do not acquire credentials", async () => {
	let reads = 0;
	const x = await setup(async () => {
		reads++;
		return { callTool: async () => ({ content: [] }) };
	});
	try {
		const r = await x.client.callTool({
			name: "etrade_list_accounts",
			arguments: { unexpected: true },
		});
		assert.equal(r.isError, true);
		assert.equal(reads, 0);
	} finally {
		await x.close();
	}
});
test("closed backend reconnects only on a new tool call", async () => {
	let reads = 0;
	let backend!: Backend;
	const x = await setup(async () => {
		reads++;
		backend = { callTool: async () => ({ content: [] }) };
		return backend;
	});
	try {
		await x.client.callTool({ name: "etrade_list_accounts" });
		backend.onclose?.();
		await x.client.listTools();
		assert.equal(reads, 1);
		await x.client.callTool({ name: "etrade_list_accounts" });
		assert.equal(reads, 2);
	} finally {
		await x.close();
	}
});
test("one cancelled waiter does not cancel another active caller", async () => {
	let release!: () => void;
	let signal!: AbortSignal;
	let calls = 0;
	const ready = new Promise<void>((r) => (release = r));
	const x = await setup(async (s) => {
		signal = s;
		await ready;
		return {
			callTool: async () => {
				calls++;
				return { content: [] };
			},
		};
	});
	try {
		const c = new AbortController();
		const first = x.client.callTool({ name: "etrade_list_accounts" }, undefined, {
			signal: c.signal,
		});
		const second = x.client.callTool({ name: "etrade_list_accounts" });
		await new Promise((r) => setTimeout(r, 10));
		c.abort();
		await assert.rejects(first);
		await new Promise((r) => setTimeout(r, 10));
		assert.equal(signal.aborted, false);
		release();
		await second;
		assert.equal(calls, 1);
	} finally {
		await x.close();
	}
});
test("unsupported progress metadata is not forwarded to backend", async () => {
	let forwarded!: CallToolRequest["params"];
	const x = await setup(async () => ({
		callTool: async (p) => {
			forwarded = p;
			return { content: [] };
		},
	}));
	try {
		await x.client.callTool({ name: "etrade_list_accounts", _meta: { progressToken: "dummy" } });
		assert.equal(forwarded._meta, undefined);
	} finally {
		await x.close();
	}
});
