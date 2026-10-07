import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readReadonlyConfig } from "../readonly-config.js";
import { buildReadonlyEnvironment } from "../readonly-policy.js";
const config = {
	environment: "sandbox" as const,
	credentialMount: "credentials.pipe",
	accountIdKey: "dummy-account",
};
const key = Buffer.alloc(32, 7).toString("base64");
const secrets = {
	ETRADE_SANDBOX_API_KEY: "dummy-key",
	ETRADE_SANDBOX_API_KEY_SECRET: "dummy-secret",
	ETRADE_TOKEN_ENCRYPTION_KEY: key,
};
function fixture(value: unknown, fn: (path: string, dir: string) => void) {
	const dir = mkdtempSync(join(tmpdir(), "readonly config "));
	try {
		const path = join(dir, "config.json");
		writeFileSync(path, JSON.stringify(value));
		fn(path, dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
test("config resolves mount relative to its own directory including spaces", () =>
	fixture(config, (path, dir) => {
		expect(readReadonlyConfig(path)).toEqual({
			...config,
			credentialMount: join(dir, "credentials.pipe"),
		});
	}));
test("config rejects missing, extra and malformed fields without echoing private values", () => {
	for (const value of [
		null,
		[],
		{},
		{ ...config, environment: undefined },
		{ ...config, environment: "live" },
		{ ...config, extra: "PRIVATE" },
		{ ...config, accountIdKey: "../PRIVATE" },
		{ ...config, credentialMount: "" },
		{ ...config, credentialMount: "~/pipe" },
	]) {
		fixture(value, (path) => {
			expect(() => readReadonlyConfig(path)).toThrow();
			try {
				readReadonlyConfig(path);
			} catch (e) {
				expect(String(e)).not.toContain("PRIVATE");
			}
		});
	}
});
test("policy isolates secrets and forces restricted settings", () => {
	const home = join(tmpdir(), "dummy home");
	const env = buildReadonlyEnvironment(
		config,
		{
			...secrets,
			ETRADE_ALLOW_ORDERS: "1",
			HOME: "PRIVATE",
			NODE_OPTIONS: "--inspect",
			ETRADE_ALLOWED_ACCOUNT_IDS: "other",
		},
		home,
	);
	expect(env).toEqual({
		HOME: home,
		ETRADE_ENV: "sandbox",
		ETRADE_ALLOW_ORDERS: "0",
		ETRADE_LOAD_DOTENV: "0",
		ETRADE_ALLOWED_ACCOUNT_IDS: "dummy-account",
		...secrets,
	});
});
test("production selects only production credentials", () => {
	const env = buildReadonlyEnvironment(
		{ ...config, environment: "prod" },
		{ ...secrets, ETRADE_PROD_API_KEY: "prod-dummy", ETRADE_PROD_API_SECRET: "prod-secret" },
		tmpdir(),
	);
	expect(env.ETRADE_PROD_API_KEY).toBe("prod-dummy");
	expect(env.ETRADE_SANDBOX_API_KEY).toBeUndefined();
	expect(env.ETRADE_TOKEN_ENCRYPTION_KEY).toBe(key);
});
test("policy fails closed for absent or invalid credentials and encryption", () => {
	for (const s of [
		{},
		{ ...secrets, ETRADE_TOKEN_ENCRYPTION_KEY: "" },
		{ ...secrets, ETRADE_TOKEN_ENCRYPTION_KEY: "bad" },
		{ ...secrets, ETRADE_SANDBOX_API_KEY_SECRET: "" },
	])
		expect(() => buildReadonlyEnvironment(config, s, tmpdir())).toThrow();
	expect(() =>
		buildReadonlyEnvironment({ ...config, environment: "prod" }, secrets, tmpdir()),
	).toThrow();
	expect(() => buildReadonlyEnvironment(config, secrets, "")).toThrow();
});

test("policy rejects noncanonical base64 encryption keys with nonzero padding bits", () => {
	const noncanonical = "A".repeat(42) + "B=";
	expect(Buffer.from(noncanonical, "base64").length).toBe(32);
	expect(() =>
		buildReadonlyEnvironment(
			config,
			{ ...secrets, ETRADE_TOKEN_ENCRYPTION_KEY: noncanonical },
			tmpdir(),
		),
	).toThrow();
});
