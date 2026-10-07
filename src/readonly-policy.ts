import { loadEnv } from "./env.js";
import type { ReadonlyConfig } from "./readonly-config.js";

/** Never inherit arbitrary parent/provider variables into the broker process. */
export function buildReadonlyEnvironment(
	config: ReadonlyConfig,
	secrets: Record<string, string>,
	home: string,
): Record<string, string> {
	try {
		if (
			!home ||
			!/^[A-Za-z0-9_-]+$/.test(config.accountIdKey) ||
			!secrets.ETRADE_TOKEN_ENCRYPTION_KEY
		)
			throw Error();
		const names =
			config.environment === "prod"
				? ["ETRADE_PROD_API_KEY", "ETRADE_PROD_API_SECRET"]
				: ["ETRADE_SANDBOX_API_KEY", "ETRADE_SANDBOX_API_KEY_SECRET"];
		const env: Record<string, string> = {
			HOME: home,
			ETRADE_ENV: config.environment,
			ETRADE_ALLOW_ORDERS: "0",
			ETRADE_LOAD_DOTENV: "0",
			ETRADE_ALLOWED_ACCOUNT_IDS: config.accountIdKey,
			ETRADE_TOKEN_ENCRYPTION_KEY: secrets.ETRADE_TOKEN_ENCRYPTION_KEY,
		};
		for (const name of names) {
			if (!secrets[name]?.trim()) throw Error();
			env[name] = secrets[name];
		}
		loadEnv(env);
		if (
			Buffer.from(env.ETRADE_TOKEN_ENCRYPTION_KEY, "base64").toString("base64") !==
			env.ETRADE_TOKEN_ENCRYPTION_KEY
		)
			throw Error();
		return env;
	} catch {
		throw new Error(
			"Invalid credential payload. Supply matching API credentials and a valid token encryption key.",
		);
	}
}
