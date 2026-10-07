import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { computeEtMidnightExpiry, writeToken } from "../tokens.js";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
async function session(encrypted: boolean, tokenEnv = "sandbox") {
  const home = mkdtempSync(join(tmpdir(), "etrade-stdio-")); dirs.push(home);
  const key = Buffer.alloc(32, 7).toString("base64");
  const tokenPath = join(home, ".config/etrade-mcp/tokens.sandbox.json");
  writeToken(tokenPath, { env: tokenEnv as "sandbox", oauth_token: "dummy", oauth_token_secret: "dummy", obtained_at: new Date().toISOString(), expires_at_midnight_et: computeEtMidnightExpiry() }, encrypted ? key : undefined);
  const client = new Client({ name: "offline-test", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath, args: ["--no-env-file", resolve("src/mcp.ts")], cwd: home, stderr: "pipe", env: { HOME: home, ETRADE_ENV: "sandbox", ETRADE_SANDBOX_API_KEY: "dummy", ETRADE_SANDBOX_API_KEY_SECRET: "dummy", ETRADE_ALLOWED_ACCOUNT_IDS: "ira", ETRADE_ALLOW_ORDERS: "0", ...(encrypted ? { ETRADE_TOKEN_ENCRYPTION_KEY: key } : {}) } });
  await client.connect(transport);
  return client;
}
it("the MCP server reads encrypted tokens and enforces the account restriction", async () => {
  const client = await session(true);
  try {
    const result = await client.callTool({ name: "etrade_get_balance", arguments: { accountIdKey: "other" } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("not allowed");
    const { tools } = await client.listTools();
    expect(tools.some(t => t.name === "etrade_place_order")).toBe(false);
  } finally { await client.close(); }
});
it("the MCP server rejects a token from another environment before account requests", async () => {
  const client = await session(false, "prod");
  try {
    const result = await client.callTool({ name: "etrade_get_balance", arguments: { accountIdKey: "other" } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toMatch(/token.*(unreadable|environment)/i);
  } finally { await client.close(); }
});
it("a controlled launcher can disable working-directory dotenv loading", async () => {
  const home = mkdtempSync(join(tmpdir(), "etrade-dotenv-")); dirs.push(home);
  writeFileSync(join(home, ".env"), "ETRADE_ALLOW_ORDERS=1\n");
  const client = new Client({ name: "offline-test", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath, args: ["--no-env-file", resolve("src/mcp.ts")], cwd: home, stderr: "pipe", env: { HOME: home, ETRADE_ENV: "sandbox", ETRADE_SANDBOX_API_KEY: "dummy", ETRADE_SANDBOX_API_KEY_SECRET: "dummy", ETRADE_LOAD_DOTENV: "0" } });
  try {
    await client.connect(transport);
    expect((await client.listTools()).tools.some(t => t.name === "etrade_place_order")).toBe(false);
  } finally { await client.close(); }
});
it("login automation refuses before contacting the debugging browser", async () => {
  let requests = 0;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => { requests++; return Response.json([]); } });
  try {
    const child = Bun.spawn([process.execPath, resolve("src/login-fill.ts")], { env: { CDP_PORT: String(server.port), ETRADE_LOGIN_USERNAME: "dummy-user", ETRADE_LOGIN_PASSWORD: "dummy-password" }, stdout: "pipe", stderr: "pipe" });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code).not.toBe(0);
    expect(requests).toBe(0);
    expect(err).toMatch(/manual/i);
    expect(out + err).not.toContain("dummy-password");
  } finally { server.stop(true); }
});
