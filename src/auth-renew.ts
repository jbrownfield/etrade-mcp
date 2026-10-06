import type { EtradeConfig } from "./env.js";
import { signRequest } from "./oauth.js";
import { writeToken, isTokenExpired, type StoredToken } from "./tokens.js";

/**
 * Reactivate an IDLE access token via E*TRADE's `renew_access_token` — the browser-free recovery for the
 * ~2h idle timeout. E*TRADE deactivates an access token after two hours of no API calls; this revives the
 * SAME token (no consent, no login page) so long as it has not also crossed the midnight ET hard-expiry.
 *
 * This matters for any scheduled/automated caller: a token minted earlier in the day can go idle and get
 * rejected by a later run, which would otherwise fall into a browser re-auth. With renew tried FIRST, an
 * idle death self-heals with zero browser. Returns {renewed:true} on success (token file rewritten with
 * a fresh obtained_at), {renewed:false, reason} otherwise — the caller then falls back to the full 3-leg
 * browser consent (the only path that survives the midnight expiry).
 */
export async function renewAccessToken(
  cfg: EtradeConfig,
  token: StoredToken | null,
  fetchImpl: typeof fetch = fetch,
  now: Date = new Date(),
): Promise<{ renewed: boolean; reason?: string }> {
  if (!token?.oauth_token || !token?.oauth_token_secret) {
    return { renewed: false, reason: "no token to renew" };
  }

  if (token.env !== cfg.env) return { renewed: false, reason: "token environment mismatch" };

  if (isTokenExpired(token, now)) return { renewed: false, reason: "token expired; browser authorization required" };

  const url = `${cfg.apiBaseUrl}/oauth/renew_access_token`;
  const auth = signRequest(
    { consumerKey: cfg.consumerKey, consumerSecret: cfg.consumerSecret },
    { oauth_token: token.oauth_token, oauth_token_secret: token.oauth_token_secret },
    { url, method: "GET" },
  );

  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: { Authorization: auth, Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
  } catch {
    return { renewed: false, reason: "renew request failed" };
  }

  if (!res.ok) {
    // A 401 here means the token is past the point renew can save (midnight-expired or invalidated) — the
    // caller must do the full browser re-consent. We deliberately do NOT touch the token file on failure.
    return { renewed: false, reason: `renew failed (HTTP ${res.status})` };
  }

  // Require a complete returned pair or the documented confirmation before updating storage.
  // Preserve the existing midnight expiry; renewal only reactivates an idle token.
  let body: string;
  try { body = (await res.text()).trim(); }
  catch { return { renewed: false, reason: "renew response could not be read" }; }
  const params = new URLSearchParams(body);
  const returnedToken = params.get("oauth_token");
  const returnedSecret = params.get("oauth_token_secret");
  const unchanged = body === "Access Token has been renewed";
  if (!unchanged && (!returnedToken || !returnedSecret)) {
    return { renewed: false, reason: "invalid renewal response" };
  }
  const renewedToken = unchanged ? token.oauth_token : returnedToken!;
  const renewedSecret = unchanged ? token.oauth_token_secret : returnedSecret!;

  writeToken(cfg.tokenFilePath, {
    env: token.env,
    oauth_token: renewedToken,
    oauth_token_secret: renewedSecret,
    obtained_at: now.toISOString(),
    expires_at_midnight_et: token.expires_at_midnight_et,
  }, cfg.tokenEncryptionKey);
  return { renewed: true };
}
