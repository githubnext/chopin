import { expect, test } from "bun:test";

test("actual research host tool defers placement while document close drains Chat", async () => {
	let child = Bun.spawn([
		process.execPath,
		new URL("./placement-close.test-fixtures.ts", import.meta.url).pathname,
	], {
		stdout: "pipe",
		stderr: "pipe",
	});
	let [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
	expect(stderr).toContain("Research card placement is deferred");
	expect(stdout).toContain("No close deadlock in current Harness execution.");
	expect(stdout).toContain(
		"Deferred request retains its identity, pending reference, and no queued work.",
	);
}, 10_000);
