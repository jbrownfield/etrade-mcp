// Run after build under Node, independently of Bun's crypto implementation.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readToken, writeToken } from "../dist/index.js";

const directory = mkdtempSync(join(tmpdir(), "etrade-node-storage-"));
try {
  const file = join(directory, "token.json");
  const key = Buffer.alloc(32, 7).toString("base64");
  const token = { env: "sandbox", oauth_token: "dummy", oauth_token_secret: "dummy-secret", obtained_at: "2026-01-01T12:00:00Z", expires_at_midnight_et: "2026-01-02T00:00:00-05:00" };
  writeToken(file, token, key);
  assert.deepEqual(readToken(file, key), token);
  const contents = JSON.parse(readFileSync(file, "utf8"));
  for (const length of [4, 8, 12, 15]) {
    writeFileSync(file, JSON.stringify({ ...contents, tag: Buffer.from(contents.tag, "base64").subarray(0, length).toString("base64") }));
    assert.equal(readToken(file, key), null, `must reject a ${length}-byte authentication tag`);
  }
  writeFileSync(file, JSON.stringify(contents));
  assert.equal(readToken(file, Buffer.alloc(32, 8).toString("base64")), null, "must reject a wrong key");
  for (const length of [11, 13]) {
    writeFileSync(file, JSON.stringify({ ...contents, iv: Buffer.alloc(length).toString("base64") }));
    assert.equal(readToken(file, key), null, "must reject an invalid IV length");
  }
  const tampered = Buffer.from(contents.ciphertext, "base64");
  tampered[0] ^= 1;
  writeFileSync(file, JSON.stringify({ ...contents, ciphertext: tampered.toString("base64") }));
  assert.equal(readToken(file, key), null, "must reject modified ciphertext");
  console.log(`Node ${process.version}: encrypted storage round-trip and full-tag enforcement passed`);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
