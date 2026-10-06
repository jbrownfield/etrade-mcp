import { resolve, dirname } from "node:path";
import { rmSync } from "node:fs";
import { readSecret, writeSecret } from "./secret-storage.js";

import type { EtradeConfig } from "./env.js";
import { signRequest } from "./oauth.js";
import { writeToken, computeEtMidnightExpiry } from "./tokens.js";

export type RequestTokenResult = {
  requestToken: string;
  requestTokenSecret: string;
  authorizeUrl: string;
};

/** Leg 1: obtain an OAuth request token and the browser authorize URL. */
export async function fetchRequestToken(
  cfg: EtradeConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<RequestTokenResult> {
  const reqTokenUrl = `${cfg.apiBaseUrl}/oauth/request_token`;
  const auth = signRequest(
    { consumerKey: cfg.consumerKey, consumerSecret: cfg.consumerSecret },
    null,
    { url: reqTokenUrl, method: "GET", extraParams: { oauth_callback: "oob" } },
  );
  const res = await fetchImpl(reqTokenUrl, { headers: { Authorization: auth }, signal: AbortSignal.timeout(10_000), redirect: "error" });
  if (!res.ok) throw new Error(`request_token failed: ${res.status}`);
  const params = new URLSearchParams(await res.text());
  const requestToken = params.get("oauth_token");
  const requestTokenSecret = params.get("oauth_token_secret");
  if (!requestToken || !requestTokenSecret) throw new Error("malformed request_token response");
  const authorizeUrl = `${cfg.authorizeUrl}?key=${encodeURIComponent(cfg.consumerKey)}&token=${encodeURIComponent(requestToken)}`;
  return { requestToken, requestTokenSecret, authorizeUrl };
}

/** Leg 3: exchange the verifier for an access token and persist it. */
export async function exchangeVerifier(
  cfg: EtradeConfig,
  request: { requestToken: string; requestTokenSecret: string },
  verifier: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ expiresAt: string }> {
  const accessUrl = `${cfg.apiBaseUrl}/oauth/access_token`;
  const auth = signRequest(
    { consumerKey: cfg.consumerKey, consumerSecret: cfg.consumerSecret },
    { oauth_token: request.requestToken, oauth_token_secret: request.requestTokenSecret },
    { url: accessUrl, method: "GET", extraParams: { oauth_verifier: verifier } },
  );
  const res = await fetchImpl(accessUrl, { headers: { Authorization: auth }, signal: AbortSignal.timeout(10_000), redirect: "error" });
  if (!res.ok) throw new Error(`access_token failed: ${res.status}`);
  const params = new URLSearchParams(await res.text());
  const accessToken = params.get("oauth_token");
  const accessTokenSecret = params.get("oauth_token_secret");
  if (!accessToken || !accessTokenSecret) throw new Error("malformed access_token response");
  const expiresAt = computeEtMidnightExpiry();
  writeToken(cfg.tokenFilePath, {
    env: cfg.env,
    oauth_token: accessToken,
    oauth_token_secret: accessTokenSecret,
    obtained_at: new Date().toISOString(),
    expires_at_midnight_et: expiresAt,
  }, cfg.tokenEncryptionKey);
  return { expiresAt };
}

/** Where the in-flight request token is stashed between `auth:start` and `auth:finish`. */
export function pendingPath(cfg: EtradeConfig): string {
  return resolve(dirname(cfg.tokenFilePath), `pending.${cfg.env}.json`);
}
export function writePending(cfg: EtradeConfig, r: RequestTokenResult): void {
  const p = pendingPath(cfg);
  writeSecret(p, r, cfg.tokenEncryptionKey);
}
export function readPending(cfg: EtradeConfig): RequestTokenResult | null {
  try {
    const parsed = readSecret(pendingPath(cfg), cfg.tokenEncryptionKey) as RequestTokenResult;
    if (!parsed || typeof parsed.requestToken !== "string" || !parsed.requestToken ||
        typeof parsed.requestTokenSecret !== "string" || !parsed.requestTokenSecret) return null;
    return parsed;
  } catch {
    return null;
  }
}
export function clearPending(cfg: EtradeConfig): void {
  try {
    rmSync(pendingPath(cfg));
  } catch {
    /* already gone */
  }
}
