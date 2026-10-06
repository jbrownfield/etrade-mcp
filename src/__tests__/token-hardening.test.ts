import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeEtMidnightExpiry, isTokenExpired, readToken, writeToken } from "../tokens.js";
import { clearPending, exchangeVerifier, fetchRequestToken, pendingPath, readPending, writePending } from "../auth-core.js";
import { loadEnv, type EtradeConfig } from "../env.js";
const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const token = { env: "sandbox" as const, oauth_token: "dummy-access", oauth_token_secret: "dummy-access-secret", obtained_at: "2026-01-01T12:00:00Z", expires_at_midnight_et: "2026-01-02T00:00:00-05:00" };
const key = Buffer.alloc(32, 7).toString("base64");
function config(): EtradeConfig {
  const dir = mkdtempSync(join(tmpdir(), "etrade-hardening-")); directories.push(dir);
  return { env: "sandbox", consumerKey: "dummy", consumerSecret: "dummy", apiBaseUrl: "https://apisb.etrade.com", authorizeUrl: "https://us.etrade.com/e/t/etws/authorize", tokenFilePath: join(dir, "token.json"), allowOrders: false, tokenEncryptionKey: key };
}
// Literal ET midnight cases catch adding 24 hours rather than one calendar day.
describe("token expiry", () => {
  for (const [instant, expected] of [
    ["2026-11-01T17:00:00Z", "2026-11-02T00:00:00-05:00"],
    ["2026-03-08T17:00:00Z", "2026-03-09T00:00:00-04:00"],
    ["2026-12-31T17:00:00Z", "2027-01-01T00:00:00-05:00"],
    ["2026-11-01T03:30:00Z", "2026-11-01T00:00:00-04:00"],
  ]) it(`expires at next ET midnight for ${instant}`, () => expect(computeEtMidnightExpiry(new Date(instant))).toBe(expected));
  it("treats an invalid expiry as expired", () => expect(isTokenExpired({ ...token, expires_at_midnight_et: "invalid" })).toBe(true));
  it("rejects malformed stored tokens", () => {
    const cfg = config();
    writeFileSync(cfg.tokenFilePath, JSON.stringify({ ...token, obtained_at: "bad", oauth_token: 17 }));
    expect(readToken(cfg.tokenFilePath)).toBeNull();
  });
});
// Exercise real files and crypto: plaintext storage or accepting tampering must fail.
describe("protected token storage", () => {
  it("encrypts access tokens and round-trips with the same key", () => {
    const cfg = config();
    writeToken(cfg.tokenFilePath, token, key);
    expect(readFileSync(cfg.tokenFilePath, "utf8")).not.toContain("dummy-access");
    expect(readToken(cfg.tokenFilePath, key)).toEqual(token);
    expect(readToken(cfg.tokenFilePath)).toBeNull();
    expect(readToken(cfg.tokenFilePath, Buffer.alloc(32, 8).toString("base64"))).toBeNull();
    expect(statSync(cfg.tokenFilePath).mode & 0o777).toBe(0o600);
  });
  it("does not downgrade encrypted mode to an existing plaintext file", () => {
    const cfg = config(); writeToken(cfg.tokenFilePath, token);
    expect(readToken(cfg.tokenFilePath, key)).toBeNull();
  });
  it("rejects tampered ciphertext", () => {
    const cfg = config(); writeToken(cfg.tokenFilePath, token, key);
    const envelope = JSON.parse(readFileSync(cfg.tokenFilePath, "utf8"));
    envelope.ciphertext = Buffer.from("tampered").toString("base64");
    writeFileSync(cfg.tokenFilePath, JSON.stringify(envelope));
    expect(readToken(cfg.tokenFilePath, key)).toBeNull();
  });
  it("protects pending tokens and repairs existing loose permissions", () => {
    const cfg = config(); const pending = { requestToken: "dummy-request", requestTokenSecret: "dummy-request-secret", authorizeUrl: "https://example.invalid" };
    writeFileSync(pendingPath(cfg), "{}", { mode: 0o644 });
    writePending(cfg, pending);
    expect(readFileSync(pendingPath(cfg), "utf8")).not.toContain("dummy-request");
    expect(statSync(pendingPath(cfg)).mode & 0o777).toBe(0o600);
    expect(readPending(cfg)).toEqual(pending);
    clearPending(cfg);
    expect(readPending(cfg)).toBeNull();
  });
  it("rejects invalid encryption configuration", () => {
    expect(() => loadEnv({ ETRADE_ENV: "sandbox", ETRADE_SANDBOX_API_KEY: "dummy", ETRADE_SANDBOX_API_KEY_SECRET: "dummy", ETRADE_TOKEN_ENCRYPTION_KEY: "bad" })).toThrow();
  });
  it("keeps the old token intact when writing with an invalid key", () => {
    const cfg = config(); writeToken(cfg.tokenFilePath, token);
    expect(() => writeToken(cfg.tokenFilePath, { ...token, oauth_token: "changed" }, "bad")).toThrow();
    expect(readToken(cfg.tokenFilePath)).toEqual(token);
    expect(readdirSync(join(cfg.tokenFilePath, ".."))).toEqual(["token.json"]);
  });
  it("auth exchange uses protected storage", async () => {
    const cfg = config();
    await exchangeVerifier(cfg, { requestToken: "dummy", requestTokenSecret: "dummy" }, "12345", (async () => new Response("oauth_token=dummy-access&oauth_token_secret=dummy-access-secret")) as unknown as typeof fetch);
    expect(readFileSync(cfg.tokenFilePath, "utf8")).not.toContain("dummy-access");
    expect(readToken(cfg.tokenFilePath, key)?.oauth_token).toBe("dummy-access");
  });
  it("auth calls have deadlines and reject redirects", async () => {
    let init: RequestInit | undefined;
    await fetchRequestToken(config(), (async (_url: any, options: RequestInit) => { init = options; return new Response("oauth_token=dummy&oauth_token_secret=dummy"); }) as unknown as typeof fetch);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.redirect).toBe("error");
  });
  it("does not expose error bodies from authentication", async () => {
    const error = await fetchRequestToken(config(), (async () => new Response("PRIVATE-TOKEN-DATA", { status: 401 })) as unknown as typeof fetch).catch(e => e);
    expect((error as Error).message).toContain("401");
    expect((error as Error).message).not.toContain("PRIVATE-TOKEN-DATA");
  });
});

import { renewAccessToken as renewAt } from "../auth-renew.js";
// Fix the clock so renewal tests exercise a valid token on any execution date.
function renewAccessToken(cfg: EtradeConfig, token: Parameters<typeof renewAt>[1], fetchImpl: typeof fetch, now = new Date("2026-01-01T15:00:00Z")) {
  return renewAt(cfg, token, fetchImpl, now);
}
describe("renewal protection", () => {
  it("preserves encryption after renewal", async () => {
    const cfg = config();
    await renewAccessToken(cfg, token, (async () => new Response("Access Token has been renewed")) as unknown as typeof fetch);
    expect(readFileSync(cfg.tokenFilePath, "utf8")).not.toContain("dummy-access");
    expect(readToken(cfg.tokenFilePath, key)?.oauth_token).toBe("dummy-access");
  });
  it("redacts renewal errors", async () => {
    const result = await renewAccessToken(config(), token, (async () => new Response("PRIVATE-RENEW-ERROR", { status: 401 })) as unknown as typeof fetch);
    expect(result.reason).toContain("401");
    expect(result.reason).not.toContain("PRIVATE-RENEW-ERROR");
  });
});

it("does not send a token to the wrong environment during renewal", async () => {
  let calls = 0;
  const result = await renewAccessToken(config(), { ...token, env: "prod" }, (async () => { calls++; return new Response(""); }) as unknown as typeof fetch);
  expect(result.renewed).toBe(false);
  expect(calls).toBe(0);
});

it("requires a full authentication tag for encrypted token files", () => {
  const cfg = config(); writeToken(cfg.tokenFilePath, token, key);
  const envelope = JSON.parse(readFileSync(cfg.tokenFilePath, "utf8"));
  envelope.tag = Buffer.from(envelope.tag, "base64").subarray(0, 4).toString("base64");
  writeFileSync(cfg.tokenFilePath, JSON.stringify(envelope));
  expect(readToken(cfg.tokenFilePath, key)).toBeNull();
});
it("rejects malformed pending token fields", () => {
  const cfg = { ...config(), tokenEncryptionKey: undefined };
  writeFileSync(pendingPath(cfg), JSON.stringify({ requestToken: 123, requestTokenSecret: ["dummy"] }));
  expect(readPending(cfg)).toBeNull();
});

// Renewal must not claim success or replace a known-good pair on a partial response.
it("does not persist a mismatched pair from a partial renewal response", async () => {
  const cfg = config(); writeToken(cfg.tokenFilePath, token, key);
  const original = readFileSync(cfg.tokenFilePath, "utf8");
  const result = await renewAccessToken(cfg, token, (async () => new Response("oauth_token=changed")) as unknown as typeof fetch);
  expect(result.renewed).toBe(false);
  expect(readFileSync(cfg.tokenFilePath, "utf8")).toBe(original);
});
it("does not treat an unreadable renewal response as successful", async () => {
  const cfg = config(); writeToken(cfg.tokenFilePath, token, key);
  const original = readFileSync(cfg.tokenFilePath, "utf8");
  const result = await renewAccessToken(cfg, token, (async () => ({ ok: true, text: async () => { throw new Error("PRIVATE-READ-ERROR"); } })) as unknown as typeof fetch);
  expect(result.renewed).toBe(false);
  expect(result.reason).not.toContain("PRIVATE-READ-ERROR");
  expect(readFileSync(cfg.tokenFilePath, "utf8")).toBe(original);
});
it("does not claim renewal succeeded for an HTML response", async () => {
  const result = await renewAccessToken(config(), token, (async () => new Response("<html>Login required</html>")) as unknown as typeof fetch);
  expect(result.renewed).toBe(false);
});
it("accepts the broker's documented plain-text renewal confirmation", async () => {
  const cfg = config();
  const result = await renewAccessToken(cfg, token, (async () => new Response("Access Token has been renewed")) as unknown as typeof fetch);
  expect(result.renewed).toBe(true);
  expect(readToken(cfg.tokenFilePath, key)?.oauth_token).toBe(token.oauth_token);
});
it("does not send an expired token for renewal", async () => {
  let calls = 0;
  const result = await renewAccessToken(config(), token, (async () => { calls++; return new Response(""); }) as unknown as typeof fetch, new Date("2026-01-02T05:00:00Z"));
  expect(result.renewed).toBe(false);
  expect(calls).toBe(0);
});
it("does not claim renewal succeeded without an explicit confirmation", async () => {
  const cfg = config(); writeToken(cfg.tokenFilePath, token, key);
  const original = readFileSync(cfg.tokenFilePath, "utf8");
  const result = await renewAccessToken(cfg, token, (async () => new Response("")) as unknown as typeof fetch);
  expect(result.renewed).toBe(false);
  expect(readFileSync(cfg.tokenFilePath, "utf8")).toBe(original);
});
