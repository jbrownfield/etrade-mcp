import { signRequest, type TokenPair } from "./oauth.js";
import type { EtradeConfig } from "./env.js";
import type { ListOrdersParams, PlaceOrderRequest, PreviewOrderRequest } from "./orders.js";

export type BalanceParams = {
  accountIdKey: string;
  instType?: "BROKERAGE";
  realTimeNAV?: boolean;
};

export type PortfolioParams = {
  pageNumber?: number;
  accountIdKey: string;
  count?: number;
  sortBy?: string;
  sortOrder?: "ASC" | "DESC";
  marketSession?: "REGULAR" | "EXTENDED";
  totalsRequired?: boolean;
  lotsRequired?: boolean;
  view?: "PERFORMANCE" | "FUNDAMENTAL" | "OPTIONSWATCH" | "QUICK" | "COMPLETE";
};

export type TransactionListParams = {
  accountIdKey: string;
  startDate?: string;
  endDate?: string;
  sortOrder?: "ASC" | "DESC";
  marker?: string;
  count?: number;
};

export type TransactionDetailParams = {
  accountIdKey: string;
  transactionId: string;
};

export type EtradeClient = {
  listAccounts(): Promise<unknown>;
  /** Real-time market quotes for up to 25 comma-joined symbols (GET /v1/market/quote). */
  getQuote(symbols: string[]): Promise<unknown>;
  getBalance(p: BalanceParams): Promise<unknown>;
  getPortfolio(p: PortfolioParams): Promise<unknown>;
  listTransactions(p: TransactionListParams): Promise<unknown>;
  getTransaction(p: TransactionDetailParams): Promise<unknown>;
  // --- Order API (writes; gated by EtradeConfig.allowOrders at registration) ---
  listOrders(p: ListOrdersParams): Promise<unknown>;
  previewOrder(accountIdKey: string, req: PreviewOrderRequest): Promise<unknown>;
  placeOrder(accountIdKey: string, req: PlaceOrderRequest): Promise<unknown>;
  cancelOrder(accountIdKey: string, orderId: number): Promise<unknown>;
};

export function createClient(config: EtradeConfig, token: TokenPair): EtradeClient {
  // A client retains the policy it was created with even if callers reuse config.
  const cfg = { ...config };
  const origin = cfg.env === "prod" ? "https://api.etrade.com" : "https://apisb.etrade.com";
  if (cfg.apiBaseUrl !== origin) throw new Error("Unexpected E*TRADE API origin.");
  const allowed = cfg.allowedAccountIds === undefined ? undefined : new Set(cfg.allowedAccountIds);
  function identifier(id: string): string {
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("Invalid API identifier.");
    return encodeURIComponent(id);
  }
  function account(id: string): string {
    const segment = identifier(id);
    if (allowed && !allowed.has(id)) throw new Error("Account is not allowed by this server.");
    return segment;
  }
  function validateRoute(path: string, write = false): void {
    const pathname = path.split("?")[0];
    const valid = write
      ? /^\/v1\/accounts\/[A-Za-z0-9_-]+\/orders\/(preview|place|cancel)$/.test(pathname)
      : pathname === "/v1/accounts/list" ||
        /^\/v1\/accounts\/[A-Za-z0-9_-]+\/(balance|portfolio|orders|transactions(?:\/[A-Za-z0-9_-]+)?)$/.test(pathname) ||
        /^\/v1\/market\/quote\/[A-Z0-9%:,._-]+$/.test(pathname);
    if (!valid || new URL(path, origin).pathname !== pathname) throw new Error("Unexpected E*TRADE API route.");
  }
  function errorStatus(status: number, body: string): string {
    let code: unknown;
    try { code = JSON.parse(body)?.Error?.code; } catch { /* No free-form response data in errors. */ }
    const numeric = typeof code === "number" && Number.isSafeInteger(code) && code >= 0 && code <= 999999999 ||
      typeof code === "string" && /^\d{1,9}$/.test(code);
    return `HTTP ${status}${numeric ? `; code ${code}` : ""}`;
  }
  async function get<T = unknown>(path: string): Promise<T> {
    validateRoute(path);
    const url = `${cfg.apiBaseUrl}${path}`;
    const auth = signRequest(
      { consumerKey: cfg.consumerKey, consumerSecret: cfg.consumerSecret },
      token,
      { url, method: "GET" },
    );
    const res = await fetch(url, {
      headers: { Authorization: auth, Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
    if (!res.ok) {
      throw new Error(`E*TRADE request failed (${errorStatus(res.status, await res.text().catch(() => ""))}).`);
    }
    if (res.status === 204 && path.includes("/portfolio")) return { PortfolioResponse: { AccountPortfolio: [] } } as T;
    if (res.status === 204 && /\/transactions(?:\?|$)/.test(path)) return { TransactionListResponse: { Transaction: [] } } as T;
    try { return (await res.json()) as T; }
    catch { throw new Error("E*TRADE returned an invalid JSON response."); }
  }

  // Never automatically retry a write whose outcome is uncertain.
  async function send<T = unknown>(
    path: string,
    method: "POST" | "PUT",
    body: unknown,
  ): Promise<T> {
    if (!cfg.allowOrders) throw new Error("Order writes are disabled.");
    validateRoute(path, true);
    const url = `${cfg.apiBaseUrl}${path}`;
    const auth = signRequest(
      { consumerKey: cfg.consumerKey, consumerSecret: cfg.consumerSecret },
      token,
      { url, method },
    );
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: auth,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`E*TRADE write failed (${errorStatus(res.status, text)}); verify order status before retrying.`);
    try { return JSON.parse(text) as T; }
    catch { throw new Error("E*TRADE returned an invalid write response; verify order status before retrying because the outcome is unknown."); }
  }

  function qs(params: Record<string, string | number | boolean | undefined>): string {
    const parts: string[] = [];
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined) continue;
      parts.push(`${k}=${encodeURIComponent(String(v))}`);
    }
    return parts.length ? `?${parts.join("&")}` : "";
  }

  return {
    listAccounts: async () => {
      const response = await get<{ AccountListResponse?: { Accounts?: { Account?: Array<{ accountIdKey: string }> } } }>("/v1/accounts/list");
      if (!allowed) return response;
      const accounts = response?.AccountListResponse?.Accounts?.Account;
      if (!Array.isArray(accounts) || accounts.some(a => !a || typeof a.accountIdKey !== "string" || !/^[A-Za-z0-9_-]+$/.test(a.accountIdKey))) throw new Error("Invalid account list response.");
      const discovered = new Set(accounts.map(a => a?.accountIdKey));
      if ([...allowed].some(id => !discovered.has(id))) throw new Error("A configured account is unavailable for this login.");
      return { AccountListResponse: { Accounts: { Account: accounts.filter(a => allowed.has(a.accountIdKey)) } } };
    },
    // Option contracts quote via colon notation (e.g. TKO:2027:1:15:CALL:210) — keep the
    // colons literal in the path; E*TRADE rejects them percent-encoded.
    getQuote: async (symbols) =>
      get(
        `/v1/market/quote/${symbols
          .map((s) => encodeURIComponent(s.toUpperCase()).replace(/%3A/gi, ":"))
          .join(",")}`,
      ),
    getBalance: async ({ accountIdKey, instType = "BROKERAGE", realTimeNAV = true }) => {
      if (instType !== "BROKERAGE") throw new Error("instType must be BROKERAGE, including for IRA accounts.");
      return get(`/v1/accounts/${account(accountIdKey)}/balance${qs({ instType, realTimeNAV })}`);
    },
    getPortfolio: async ({
      accountIdKey,
      count = 50,
      pageNumber,
      sortBy = "SYMBOL",
      sortOrder = "ASC",
      marketSession = "REGULAR",
      totalsRequired,
      lotsRequired,
      view = "QUICK",
    }) =>
      get(
        `/v1/accounts/${account(accountIdKey)}/portfolio${qs({
          count,
          pageNumber,
          sortBy,
          sortOrder,
          marketSession,
          totalsRequired,
          lotsRequired,
          view,
        })}`,
      ),
    listTransactions: async ({ accountIdKey, startDate, endDate, sortOrder = "DESC", marker, count = 50 }) =>
      get(
        `/v1/accounts/${account(accountIdKey)}/transactions${qs({ startDate, endDate, sortOrder, marker, count })}`,
      ),
    getTransaction: async ({ accountIdKey, transactionId }) =>
      get(`/v1/accounts/${account(accountIdKey)}/transactions/${identifier(transactionId)}`),
    listOrders: async ({ accountIdKey, count = 25, status, symbol, fromDate, toDate, marker }) =>
      get(
        `/v1/accounts/${account(accountIdKey)}/orders${qs({ count, status, symbol, fromDate, toDate, marker })}`,
      ),
    previewOrder: async (accountIdKey, req) =>
      send(`/v1/accounts/${account(accountIdKey)}/orders/preview`, "POST", { PreviewOrderRequest: req }),
    placeOrder: async (accountIdKey, req) =>
      send(`/v1/accounts/${account(accountIdKey)}/orders/place`, "POST", { PlaceOrderRequest: req }),
    cancelOrder: async (accountIdKey, orderId) =>
      send(`/v1/accounts/${account(accountIdKey)}/orders/cancel`, "PUT", { CancelOrderRequest: { orderId } }),
  };
}
