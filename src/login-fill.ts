#!/usr/bin/env bun
/** Deprecated browser autofill entrypoint. Use manual OAuth browser login. */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
export type FillField = "user" | "pw";

// Page-side field resolver + focus. Resolves the field, focuses it, and SELECTS its content so the
// subsequent Input.insertText REPLACES (not appends). Returns the pre-insert length (or -1 if not found).
// Kept as a STRING — it runs in the browser, not Bun. No secret here; only Input.insertText carries it.
export function buildFocusExpression(which: FillField): string {
  const resolver =
    which === "pw"
      ? `document.querySelector('input[type="password"]') || inputs.find(function (i) { return /password/i.test(attrs(i)); })`
      : `inputs.find(function (i) { return /user/i.test(attrs(i)); }) || inputs.find(function (i) { var t = (i.type || 'text').toLowerCase(); return t === 'text' || t === 'email'; })`;
  return `(function () {
  var inputs = Array.prototype.slice.call(document.querySelectorAll('input'));
  function attrs(i) { return (i.name || '') + (i.id || '') + (i.getAttribute('aria-label') || ''); }
  var el = ${resolver};
  if (!el) return -1;
  el.focus();
  try { el.select(); } catch (e) {}
  return (el.value || '').length;
}())`;
}

// Page-side read-back: report the two field LENGTHS (never the values) and fire change/blur so any
// framework state settles before submit. Trusted `input` events were already emitted by Input.insertText;
// change/blur are non-trust-sensitive and a synthetic dispatch is fine here.
export function buildReadbackExpression(): string {
  return `(function () {
  var inputs = Array.prototype.slice.call(document.querySelectorAll('input'));
  function attrs(i) { return (i.name || '') + (i.id || '') + (i.getAttribute('aria-label') || ''); }
  var pwEl = document.querySelector('input[type="password"]') || inputs.find(function (i) { return /password/i.test(attrs(i)); });
  var userEl = inputs.find(function (i) { return /user/i.test(attrs(i)); }) || inputs.find(function (i) { var t = (i.type || 'text').toLowerCase(); return t === 'text' || t === 'email'; });
  [userEl, pwEl].forEach(function (el) {
    if (!el) return;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  });
  return JSON.stringify({ user_len: userEl ? (userEl.value || '').length : -1, pw_len: pwEl ? (pwEl.value || '').length : -1 });
}())`;
}

export type FillStep =
  | { kind: "focus"; field: FillField }
  | { kind: "insertText"; field: FillField }
  | { kind: "readback" };

// The deterministic fill order: focus+select user, type user (trusted), focus+select pw, type pw, readback.
// The insertText steps are where the secret is carried (the runner pulls the value from the env field
// named by `field`); kept as a plan so the order + the secret-bearing steps are unit-testable.
export function planFillSequence(): FillStep[] {
  return [
    { kind: "focus", field: "user" },
    { kind: "insertText", field: "user" },
    { kind: "focus", field: "pw" },
    { kind: "insertText", field: "pw" },
    { kind: "readback" },
  ];
}

export type CdpTarget = { type: string; url?: string; title?: string; webSocketDebuggerUrl: string };

// Kept for library callers; a title can rank only already trusted HTTPS origins.
export function pickLoginTarget(targets: CdpTarget[]): CdpTarget | undefined {
  const trusted = targets.filter(target => {
    if (target.type !== "page") return false;
    try {
      const url = new URL(target.url ?? "");
      return url.origin === "https://us.etrade.com" && !url.username && !url.password &&
        ["/etx/pxy/login", "/e/t/etws/authorize", "/home/welcome-back"].includes(url.pathname);
    } catch { return false; }
  });
  return trusted.find(target => /Log\s*(?:on|in)\s+to\s+E\*TRADE/i.test(target.title ?? "")) ?? trusted[0];
}

/** Find the open E*TRADE login page among the browser's CDP targets. */
export async function findLoginTarget(port: string): Promise<CdpTarget> {
  const targets = (await (await fetch(`http://localhost:${port}/json`)).json()) as CdpTarget[];
  const t = pickLoginTarget(targets);
  if (!t) throw new Error(`E*TRADE login page not found among CDP targets on :${port} (start Arc with the debug port and land on the login page first)`);
  return t;
}

// Portable "is this the entrypoint" check (node-safe; import.meta.main is Bun-only) — true only
// when this file was invoked directly (`node dist/login-fill.js` / `bun run src/login-fill.ts`),
// never when another module imports the pure helpers above.
let isMain = false;
if (process.argv[1]) {
  try { isMain = fileURLToPath(import.meta.url) === realpathSync(process.argv[1]); }
  catch { /* Imported by a runner without a filesystem entrypoint. */ }
}

if (isMain) {
  const help = process.argv.includes("--help") || process.argv.includes("-h");
  console.error("Password autofill is disabled. Use manual browser login with etrade-mcp-auth.");
  process.exit(help ? 0 : 1);
}
