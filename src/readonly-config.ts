import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
export type ReadonlyConfig = {
	environment: "sandbox" | "prod";
	credentialMount: string;
	accountIdKey: string;
};

/** Reads only nonsecret configuration. Never opens the credential provider. */
export function readReadonlyConfig(configPath: string): ReadonlyConfig {
	try {
		const path = resolve(configPath);
		const value = JSON.parse(readFileSync(path, "utf8"));
		if (
			!value ||
			Array.isArray(value) ||
			typeof value !== "object" ||
			Object.keys(value).sort().join(",") !== "accountIdKey,credentialMount,environment" ||
			!["sandbox", "prod"].includes(value.environment) ||
			typeof value.accountIdKey !== "string" ||
			!/^[A-Za-z0-9_-]+$/.test(value.accountIdKey) ||
			typeof value.credentialMount !== "string" ||
			!value.credentialMount.trim() ||
			value.credentialMount.startsWith("~") ||
			value.credentialMount.includes("\0")
		)
			throw Error();
		return {
			environment: value.environment,
			accountIdKey: value.accountIdKey,
			credentialMount: resolve(dirname(path), value.credentialMount),
		};
	} catch {
		throw new Error(
			"Invalid read-only configuration. Check environment, credentialMount and accountIdKey.",
		);
	}
}
