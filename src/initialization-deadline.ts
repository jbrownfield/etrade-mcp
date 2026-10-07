/** A scoped signal: completed initialization must not emit cancellation later. */
export async function withInitializationDeadline<T>(
	parent: AbortSignal,
	operation: (signal: AbortSignal) => Promise<T>,
	timeoutMs = 55000,
): Promise<T> {
	parent.throwIfAborted();
	const controller = new AbortController();
	const abort = () => controller.abort(parent.reason);
	parent.addEventListener("abort", abort, { once: true });
	const timer = setTimeout(() => controller.abort(Error("Initialization timed out")), timeoutMs);
	try {
		return await operation(controller.signal);
	} finally {
		clearTimeout(timer);
		parent.removeEventListener("abort", abort);
	}
}
