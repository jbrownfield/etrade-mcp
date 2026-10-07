import { openSync, readSync, closeSync, fstatSync, constants } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

/** Read one EOF-terminated payload without a blocking FIFO open or unbounded wait. */
export async function readSecureMount(
	path: string,
	{
		signal,
		timeoutMs = 45000,
		maxBytes = 65536,
	}: { signal?: AbortSignal; timeoutMs?: number; maxBytes?: number } = {},
): Promise<Buffer> {
	signal?.throwIfAborted();
	if (process.platform !== "darwin" && process.platform !== "linux")
		throw Error("Credential FIFO requires macOS or Linux.");
	const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
	const parts: Buffer[] = [];
	let size = 0;
	const deadline = Date.now() + timeoutMs;
	const buffer = Buffer.alloc(4096);
	try {
		const stat = fstatSync(fd);
		if (!stat.isFIFO()) throw Error("Secure FIFO required");
		if (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
			throw Error("Credential FIFO must be private to the current user (mode 600).");
		while (true) {
			signal?.throwIfAborted();
			if (Date.now() >= deadline) throw Error("Credential approval timed out");
			let n: number;
			try {
				n = readSync(fd, buffer, 0, buffer.length, null);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EAGAIN") throw error;
				n = -1;
			}
			if (n > 0) {
				size += n;
				if (size > maxBytes) throw Error("Environment too large");
				parts.push(Buffer.from(buffer.subarray(0, n)));
				continue;
			}
			if (n === 0 && size > 0) return Buffer.concat(parts);
			await delay(25, undefined, { signal });
		}
	} finally {
		closeSync(fd);
		buffer.fill(0);
		for (const part of parts) part.fill(0);
	}
}
