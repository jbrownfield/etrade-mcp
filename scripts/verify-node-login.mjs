import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
const directory = mkdtempSync(join(tmpdir(), "etrade-node-login-"));
try {
  const source = new URL("../dist/login-fill.js", import.meta.url);
  const bin = join(directory, "etrade-mcp-login-fill");
  symlinkSync(fileURLToPath(source), bin);
  const env = { PATH: process.env.PATH, HOME: directory };
  writeFileSync(join(directory, ".env"), "ETRADE_LOGIN_PASSWORD=dummy-password\n");
  const imported = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(source.href)}); if (process.env.ETRADE_LOGIN_PASSWORD) process.exit(2);`], { cwd: directory, env, encoding: "utf8" });
  assert.equal(imported.status, 0, "importing the disabled helper must not load login credentials");
  const invoked = spawnSync(process.execPath, [bin], { cwd: directory, env, encoding: "utf8" });
  assert.equal(invoked.status, 1, "bin symlink must refuse login automation");
  assert.match(invoked.stderr, /manual browser login/);
  assert.ok(!invoked.stderr.includes("dummy-password"));
  console.log(`Node ${process.version}: disabled login helper is import-safe and refuses bin invocation`);
} finally { rmSync(directory, { recursive: true, force: true }); }
