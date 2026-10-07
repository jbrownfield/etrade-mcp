/** Keep this entrypoint's support policy separate from the rest of the package. */
export function assertReadonlyRuntime(
	versions: { node: string; bun?: string },
	platform: string,
): void {
	if (versions.bun || !/^\d+\./.test(versions.node) || Number(versions.node.split(".")[0]) < 22)
		throw Error(
			"The read-only launcher requires Node 22 or newer; Bun execution is not supported.",
		);
	if (!["darwin", "linux"].includes(platform))
		throw Error("Credential FIFO requires macOS or Linux.");
}
