import { test, expect } from "bun:test";
import { withInitializationDeadline } from "../initialization-deadline.js";
test("completed initialization does not emit late timeout or parent cancellation", async () => {
	const parent = new AbortController();
	let signal!: AbortSignal;
	await withInitializationDeadline(
		parent.signal,
		async (s) => {
			signal = s;
		},
		20,
	);
	await new Promise((r) => setTimeout(r, 40));
	parent.abort();
	expect(signal.aborted).toBe(false);
});
test("pending initialization is cancelled by its parent and its deadline", async () => {
	for (const cancel of [false, true]) {
		const parent = new AbortController();
		const p = withInitializationDeadline(
			parent.signal,
			(s) =>
				new Promise<void>((_, reject) =>
					s.addEventListener("abort", () => reject(Error("aborted")), { once: true }),
				),
			20,
		);
		if (cancel) parent.abort();
		await expect(p).rejects.toThrow("aborted");
	}
});
