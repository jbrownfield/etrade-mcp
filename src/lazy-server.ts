import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
	ListToolsRequestSchema,
	CallToolRequestSchema,
	type Tool,
	type CallToolRequest,
	type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";

export interface Backend {
	onclose?: () => void;
	close?: () => Promise<void>;
	callTool(
		params: CallToolRequest["params"],
		schema?: undefined,
		options?: { signal?: AbortSignal },
	): ReturnType<Client["callTool"]>;
}
const failure = (): CallToolResult => ({
	isError: true,
	content: [
		{
			type: "text",
			text: "E*TRADE access unavailable. Check credential-provider approval and configuration. If authorization has expired, authorize again with the same encryption key, then retry.",
		},
	],
});
type State = {
	controller: AbortController;
	waiters: number;
	ready: boolean;
	promise: Promise<Backend>;
};

export function createLazyServer(
	tools: Tool[],
	connectBackend: (signal: AbortSignal) => Promise<Backend>,
	version = "1.0.0",
) {
	const server = new Server(
		{ name: "etrade-mcp-readonly", version },
		{ capabilities: { tools: {} } },
	);
	const validator = new AjvJsonSchemaValidator();
	const validators = new Map(
		tools.map((tool) => [
			tool.name,
			validator.getValidator({ ...tool.inputSchema, additionalProperties: false }),
		]),
	);
	let state: State | undefined;
	let stopped = false;
	const abortPending = () => {
		stopped = true;
		state?.controller.abort();
	};
	server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
	server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
		const validate = validators.get(request.params.name);
		if (!validate || !validate(request.params.arguments ?? {}).valid)
			return {
				isError: true,
				content: [{ type: "text", text: "Unknown, disabled, or invalid tool request." }],
			};
		if (stopped || extra.signal.aborted) return failure();
		if (!state) {
			const controller = new AbortController();
			const s: State = {
				controller,
				waiters: 0,
				ready: false,
				promise: Promise.resolve().then(() => connectBackend(controller.signal)),
			};
			state = s;
			s.promise = s.promise
				.then(async (backend) => {
					if (controller.signal.aborted) {
						await backend.close?.();
						throw Error("Cancelled");
					}
					s.ready = true;
					const prior = backend.onclose;
					backend.onclose = () => {
						if (state === s) state = undefined;
						prior?.();
					};
					return backend;
				})
				.catch(() => {
					if (state === s) state = undefined;
					throw Error("Unavailable");
				});
		}
		const s = state;
		s.waiters++;
		let abort!: () => void;
		const cancelled = new Promise<never>((_, reject) => {
			abort = () => reject(Error("Cancelled"));
			extra.signal.addEventListener("abort", abort, { once: true });
			if (extra.signal.aborted) abort();
		});
		try {
			const backend = await Promise.race([s.promise, cancelled]);
			if (extra.signal.aborted || stopped) return failure();
			const { _meta, ...params } = request.params;
			const result = await backend.callTool(params, undefined, { signal: extra.signal });
			return result.isError ? failure() : result;
		} catch {
			return failure();
		} finally {
			extra.signal.removeEventListener("abort", abort);
			s.waiters--;
			if (!s.ready && s.waiters === 0) {
				s.controller.abort();
				if (state === s) state = undefined;
			}
		}
	});
	return Object.assign(server, { abortPending });
}
