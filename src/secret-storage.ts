import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function encryptionKey(value: string): Buffer {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) throw new Error("Token encryption key must be 32 bytes encoded as base64.");
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) throw new Error("Invalid token encryption key.");
  return key;
}

/** Write a complete owner-only replacement; readers never see a partial JSON file. */
export function writeSecret(path: string, value: unknown, key?: string): void {
  let contents = JSON.stringify(value);
  if (key !== undefined) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", encryptionKey(key), iv, { authTagLength: 16 });
    const ciphertext = Buffer.concat([cipher.update(contents, "utf8"), cipher.final()]);
    contents = JSON.stringify({ version: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") });
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomBytes(16).toString("hex")}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, contents);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(temporary, { force: true });
  }
}

export function readSecret(path: string, key?: string): unknown {
  const stored = JSON.parse(readFileSync(path, "utf8"));
  if (key === undefined) {
    if (stored?.version === 1) throw new Error("Encrypted token requires a key.");
    return stored;
  }
  if (stored?.version !== 1) throw new Error("Expected encrypted storage; authenticate again.");
  if (typeof stored.iv !== "string" || typeof stored.tag !== "string" || typeof stored.ciphertext !== "string") {
    throw new Error("Invalid encrypted token envelope.");
  }
  const iv = Buffer.from(stored.iv, "base64");
  const tag = Buffer.from(stored.tag, "base64");
  if (iv.length !== 12 || tag.length !== 16) throw new Error("Invalid encrypted token envelope.");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(key), iv, { authTagLength: 16 });
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(stored.ciphertext, "base64")), decipher.final()]).toString("utf8"));
}
