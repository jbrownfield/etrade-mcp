import { test, expect } from "bun:test";
import {
	chmodSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
	symlinkSync,
	openSync,
	writeSync,
	closeSync,
	constants,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSecureMount } from "../secure-mount.js";
async function fixture(fn: (path: string) => Promise<void>) {
	const dir = mkdtempSync(join(tmpdir(), "readonly-fifo-"));
	try {
		const path = join(dir, "pipe");
		execFileSync("mkfifo", ["-m", "600", path]);
		await fn(path);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
const fifoTest = process.platform === "win32" ? test.skip : test;
fifoTest("empty FIFO times out instead of blocking", () =>
	fixture(async (path) => {
		await expect(readSecureMount(path, { timeoutMs: 30 })).rejects.toThrow("timed out");
	}),
);
fifoTest("read cancels promptly without writer", () =>
	fixture(async (path) => {
		const c = new AbortController();
		const p = readSecureMount(path, { signal: c.signal });
		c.abort();
		await expect(p).rejects.toThrow();
	}),
);
test("already aborted read does not open even a nonexistent path", async () => {
	const c = new AbortController();
	c.abort();
	await expect(readSecureMount("does-not-exist", { signal: c.signal })).rejects.toHaveProperty(
		"name",
		"AbortError",
	);
});
fifoTest("regular files and symlinks cannot supply credentials", () =>
	fixture(async (path) => {
		rmSync(path);
		writeFileSync(path, "dummy");
		await expect(readSecureMount(path)).rejects.toThrow("FIFO");
		const link = path + "-link";
		symlinkSync(path, link);
		await expect(readSecureMount(link)).rejects.toThrow();
	}),
);
async function writeDummy(path: string, value: string) {
	const fd = openSync(path, constants.O_WRONLY | constants.O_NONBLOCK);
	try {
		writeSync(fd, value);
	} finally {
		closeSync(fd);
	}
}
// Writers only exist during a test; no secret manager or real credential mount is accessed.
fifoTest("completed FIFO payload is returned intact", () =>
	fixture(async (path) => {
		const p = readSecureMount(path);
		const writer = writeDummy(path, "DUMMY=value\n");
		expect((await p).toString()).toBe("DUMMY=value\n");
		await writer;
	}),
);
fifoTest("oversize payload is rejected", () =>
	fixture(async (path) => {
		const p = readSecureMount(path, { maxBytes: 4 });
		const writer = writeDummy(path, "DUMMY=value\n");
		await expect(p).rejects.toThrow("large");
		await writer;
	}),
);

fifoTest("group or world accessible pipes are refused before credential reads", () =>
	fixture(async (path) => {
		chmodSync(path, 0o644);
		await expect(readSecureMount(path, { timeoutMs: 30 })).rejects.toThrow("private");
	}),
);
fifoTest("writer may wait before delivering a multi-chunk payload", () =>
	fixture(async (path) => {
		const payload = "DUMMY=" + "x".repeat(5000) + "\n";
		const p = readSecureMount(path);
		const fd = openSync(path, constants.O_WRONLY | constants.O_NONBLOCK);
		try {
			await new Promise((r) => setTimeout(r, 40));
			writeSync(fd, payload);
		} finally {
			closeSync(fd);
		}
		expect((await p).toString()).toBe(payload);
	}),
);
