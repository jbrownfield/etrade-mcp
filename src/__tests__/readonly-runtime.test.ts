import { test, expect } from "bun:test";
import { assertReadonlyRuntime } from "../readonly-runtime.js";
test("launcher refuses unsupported runtimes and platforms before starting", () => {
	for (const [versions, platform] of [
		[{ node: "20.0.0" }, "linux"],
		[{ node: "22.0.0", bun: "1.4.2" }, "darwin"],
		[{ node: "22.0.0" }, "win32"],
	] as const)
		expect(() => assertReadonlyRuntime(versions, platform)).toThrow();
	expect(() => assertReadonlyRuntime({ node: "22.0.0" }, "linux")).not.toThrow();
	expect(() => assertReadonlyRuntime({ node: "26.0.0" }, "darwin")).not.toThrow();
});
