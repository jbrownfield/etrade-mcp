import { encryptionKey } from "./secret-storage.js";

export type EtradeEnv = "sandbox" | "prod";

export type EtradeConfig = {
  env: EtradeEnv;
  consumerKey: string;
  consumerSecret: string;
  apiBaseUrl: string;
  authorizeUrl: string;
  tokenFilePath: string;
  /**
   * Order-placement kill switch. Order tools (preview/place/cancel) are only
   * registered when this is true. Off by default so the server is read-only
   * unless you deliberately opt in with `ETRADE_ALLOW_ORDERS=1`.
   */
  allowOrders: boolean;
  allowedAccountIds?: string[];
  tokenEncryptionKey?: string;
};

const AUTHORIZE_URL = "https://us.etrade.com/e/t/etws/authorize";

export function loadEnv(source: Record<string, string | undefined> = process.env): EtradeConfig {
  const env = source.ETRADE_ENV;
  if (env !== "sandbox" && env !== "prod") throw new Error("ETRADE_ENV must explicitly be sandbox or prod.");
  const allowedAccountIds = source.ETRADE_ALLOWED_ACCOUNT_IDS?.split(",").map(id => id.trim());
  if (allowedAccountIds?.some(id => !/^[A-Za-z0-9_-]+$/.test(id))) {
    throw new Error("ETRADE_ALLOWED_ACCOUNT_IDS must contain nonempty account keys.");
  }

  const tokenEncryptionKey = source.ETRADE_TOKEN_ENCRYPTION_KEY;
  if (tokenEncryptionKey !== undefined) encryptionKey(tokenEncryptionKey);

  const keyVar = env === "prod" ? "ETRADE_PROD_API_KEY" : "ETRADE_SANDBOX_API_KEY";
  const secretVar = env === "prod" ? "ETRADE_PROD_API_SECRET" : "ETRADE_SANDBOX_API_KEY_SECRET";
  const consumerKey = source[keyVar];
  const consumerSecret = source[secretVar];

  if (!consumerKey || !consumerSecret) {
    throw new Error(
      `Missing E*TRADE credentials for env=${env}. Set ${keyVar} and ${secretVar} in your .env.`,
    );
  }

  const home = source.HOME ?? process.env.HOME ?? "";
  return {
    env,
    allowedAccountIds,
    tokenEncryptionKey,
    consumerKey,
    consumerSecret,
    apiBaseUrl: env === "prod" ? "https://api.etrade.com" : "https://apisb.etrade.com",
    authorizeUrl: AUTHORIZE_URL,
    tokenFilePath: `${home}/.config/etrade-mcp/tokens.${env}.json`,
    allowOrders: source.ETRADE_ALLOW_ORDERS === "1",
  };
}
