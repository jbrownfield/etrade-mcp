import { afterEach, describe, expect, it } from "bun:test";
import { createClient } from "../client.js";
import { loadEnv, type EtradeConfig } from "../env.js";

const cfg: EtradeConfig = { env: "sandbox", consumerKey: "dummy", consumerSecret: "dummy", apiBaseUrl: "https://apisb.etrade.com", authorizeUrl: "https://us.etrade.com/e/t/etws/authorize", tokenFilePath: "/unused", allowOrders: false };
const token = { oauth_token: "dummy", oauth_token_secret: "dummy" };
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
function respond(body: unknown, status = 200) {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (url: any, init?: RequestInit) => {
    requests.push({ url: String(url), init });
    return new Response(status === 204 ? null : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return requests;
}
// These cases catch silently choosing production, widening the account scope,
// and signing unsafe routes or writes before checking local policy.
describe("configuration and request boundaries", () => {
  for (const value of [undefined, "", "sandbx"]) it(`rejects ambiguous environment ${value}`, () => {
    expect(() => loadEnv({ ETRADE_ENV: value, ETRADE_PROD_API_KEY: "dummy", ETRADE_PROD_API_SECRET: "dummy" })).toThrow();
  });
  it("parses an explicit account restriction", () => {
    expect(loadEnv({ ETRADE_ENV: "sandbox", ETRADE_SANDBOX_API_KEY: "dummy", ETRADE_SANDBOX_API_KEY_SECRET: "dummy", ETRADE_ALLOWED_ACCOUNT_IDS: "ira, second" }).allowedAccountIds).toEqual(["ira", "second"]);
  });
  it("rejects an empty account restriction rather than allowing all accounts", () => {
    expect(() => loadEnv({ ETRADE_ENV: "sandbox", ETRADE_SANDBOX_API_KEY: "dummy", ETRADE_SANDBOX_API_KEY_SECRET: "dummy", ETRADE_ALLOWED_ACCOUNT_IDS: "" })).toThrow();
  });
  it("filters account discovery", async () => {
    respond({ AccountListResponse: { Accounts: { Account: [{ accountIdKey: "ira" }, { accountIdKey: "other" }] } } });
    const client = createClient({ ...cfg, allowedAccountIds: ["ira"] }, token);
    expect(await client.listAccounts()).toEqual({ AccountListResponse: { Accounts: { Account: [{ accountIdKey: "ira" }] } } });
  });
  it("rejects another account before issuing any request", async () => {
    const requests = respond({});
    const client = createClient({ ...cfg, allowedAccountIds: ["ira"] }, token);
    for (const call of [() => client.getBalance({ accountIdKey: "other" }), () => client.getPortfolio({ accountIdKey: "other" }), () => client.listTransactions({ accountIdKey: "other" }), () => client.getTransaction({ accountIdKey: "other", transactionId: "123" }), () => client.listOrders({ accountIdKey: "other" })]) {
      await expect(Promise.resolve().then(call)).rejects.toThrow(/allowed/);
    }
    expect(requests).toHaveLength(0);
  });
  for (const id of ["../list", "a/b", "a?x=y", "a#b", "%2e%2e", "a\\b", ".", ""]) it(`rejects unsafe path identifier ${id}`, async () => {
    const requests = respond({});
    const client = createClient(cfg, token);
    await expect(Promise.resolve().then(() => client.getTransaction({ accountIdKey: "ira", transactionId: id }))).rejects.toThrow();
    await expect(Promise.resolve().then(() => client.getBalance({ accountIdKey: id }))).rejects.toThrow();
    expect(requests).toHaveLength(0);
  });
  it("blocks every order write in a read-only library client", async () => {
    const requests = respond({});
    const c = createClient(cfg, token);
    for (const call of [() => c.previewOrder("ira", {} as any), () => c.placeOrder("ira", {} as any), () => c.cancelOrder("ira", 123)]) await expect(Promise.resolve().then(call)).rejects.toThrow(/disabled/);
    expect(requests).toHaveLength(0);
  });
  it("rejects unexpected API origins", () => {
    expect(() => createClient({ ...cfg, apiBaseUrl: "https://example.invalid" }, token)).toThrow();
  });
  it("does not follow redirects with signed requests", async () => {
    const requests = respond({});
    await createClient(cfg, token).listAccounts();
    expect(requests[0].init?.redirect).toBe("error");
  });
  it("redacts broker error bodies", async () => {
    respond({ secret: "PRIVATE-UPSTREAM-DATA" }, 401);
    const error = await createClient(cfg, token).listAccounts().catch(e => e);
    expect((error as Error).message).toContain("401");
    expect((error as Error).message).not.toContain("PRIVATE-UPSTREAM-DATA");
  });
  it("handles an empty portfolio response", async () => {
    respond(null, 204);
    expect(await createClient(cfg, token).getPortfolio({ accountIdKey: "ira" })).toEqual({ PortfolioResponse: { AccountPortfolio: [] } });
  });
  it("passes portfolio page numbers to the broker", async () => {
    const requests = respond({});
    await createClient(cfg, token).getPortfolio({ accountIdKey: "ira", pageNumber: 2 });
    expect(new URL(requests[0].url).searchParams.get("pageNumber")).toBe("2");
  });
});

describe("remaining request protections", () => {
  it("does not expose an invalid JSON response body", async () => {
    globalThis.fetch = (async () => new Response("PRIVATE-JSON-ERROR")) as unknown as typeof fetch;
    const error = await createClient(cfg, token).listAccounts().catch(e => e);
    expect((error as Error).message).not.toContain("PRIVATE-JSON-ERROR");
  });
  it("redacts write errors without hiding an uncertain order outcome", async () => {
    respond({ secret: "PRIVATE-WRITE-ERROR" }, 500);
    const error = await createClient({ ...cfg, allowOrders: true }, token).placeOrder("ira", {} as any).catch(e => e);
    expect((error as Error).message).not.toContain("PRIVATE-WRITE-ERROR");
    expect((error as Error).message).toMatch(/verify.*order/i);
  });
  it("redacts invalid successful write responses and warns before retrying", async () => {
    globalThis.fetch = (async () => new Response("PRIVATE-WRITE-RESPONSE")) as unknown as typeof fetch;
    const error = await createClient({ ...cfg, allowOrders: true }, token).placeOrder("ira", {} as any).catch(e => e);
    expect((error as Error).message).not.toContain("PRIVATE-WRITE-RESPONSE");
    expect((error as Error).message).toMatch(/verify.*order/i);
  });
  it("rejects normalized quote paths before a network call", async () => {
    const requests = respond({});
    await expect(Promise.resolve().then(() => createClient(cfg, token).getQuote([".."])) ).rejects.toThrow();
    expect(requests).toHaveLength(0);
  });
  it("treats empty transaction responses as an empty page", async () => {
    respond(null, 204);
    expect(await createClient(cfg, token).listTransactions({ accountIdKey: "ira" })).toEqual({ TransactionListResponse: { Transaction: [] } });
  });
  it("rejects the undocumented IRA institution parameter", async () => {
    const requests = respond({});
    await expect(Promise.resolve().then(() => createClient(cfg, token).getBalance({ accountIdKey: "ira", instType: "IRA" as any }))).rejects.toThrow();
    expect(requests).toHaveLength(0);
  });
});

describe("immutable client policy", () => {
  it("keeps the validated origin even if the caller reuses and mutates its config", async () => {
    const requests = respond({});
    const mutable = { ...cfg };
    const c = createClient(mutable, token);
    mutable.apiBaseUrl = "https://example.invalid";
    await c.listAccounts();
    expect(requests[0].url).toBe("https://apisb.etrade.com/v1/accounts/list");
  });
  it("does not enable writes when the original config is changed after construction", async () => {
    const requests = respond({});
    const mutable = { ...cfg };
    const c = createClient(mutable, token);
    mutable.allowOrders = true;
    await expect(c.placeOrder("ira", {} as any)).rejects.toThrow(/disabled/);
    expect(requests).toHaveLength(0);
  });
});

it("rejects a missing configured account instead of returning a complete empty portfolio", async () => {
  respond({ AccountListResponse: { Accounts: { Account: [{ accountIdKey: "different" }] } } });
  await expect(createClient({ ...cfg, allowedAccountIds: ["ira"] }, token).listAccounts()).rejects.toThrow(/configured account/i);
});
it("rejects a partially missing account restriction", async () => {
  respond({ AccountListResponse: { Accounts: { Account: [{ accountIdKey: "ira" }] } } });
  await expect(createClient({ ...cfg, allowedAccountIds: ["ira", "missing"] }, token).listAccounts()).rejects.toThrow(/configured account/i);
});
it("keeps numeric broker error codes without exposing the message", async () => {
  respond({ Error: { code: 100, message: "PRIVATE-BROKER-MESSAGE" } }, 400);
  const error = await createClient(cfg, token).listAccounts().catch(e => e) as Error;
  expect(error.message).toContain("400");
  expect(error.message).toContain("code 100");
  expect(error.message).not.toContain("PRIVATE-BROKER-MESSAGE");
});
it("never surfaces a nonnumeric broker error code", async () => {
  respond({ Error: { code: "PRIVATE-CODE", message: "PRIVATE-MESSAGE" } }, 400);
  const error = await createClient(cfg, token).listAccounts().catch(e => e) as Error;
  expect(error.message).not.toContain("PRIVATE");
});
it("rejects null account records with a sanitized response error", async () => {
  respond({ AccountListResponse: { Accounts: { Account: [null, { accountIdKey: "ira" }] } } });
  await expect(createClient({ ...cfg, allowedAccountIds: ["ira"] }, token).listAccounts()).rejects.toThrow("Invalid account list response.");
});
it("bounds numeric error codes to the same range as string codes", async () => {
  respond({ Error: { code: 1234567890123456 } }, 400);
  const error = await createClient(cfg, token).listAccounts().catch(e => e) as Error;
  expect(error.message).not.toContain("1234567890123456");
});
it("returns rejected promises for account validation failures", async () => {
  respond({});
  const pending = createClient({ ...cfg, allowedAccountIds: ["ira"] }, token).getBalance({ accountIdKey: "other" });
  expect(pending).toBeInstanceOf(Promise);
  await expect(pending).rejects.toThrow(/not allowed/);
});
