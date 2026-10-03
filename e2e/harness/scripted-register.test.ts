import { expect, test } from "bun:test";
import { join } from "node:path";
import { environment } from "../../scripts/conversation-plan-worker";
import { ROOT } from "../servers";

// A nonexistent local database URL is parsed only; discovery performs no SQL operation.
let env = environment({
	nonce: "a".repeat(32),
	key: "b".repeat(64),
	commit: "c".repeat(40),
	database: "postgres://offline:placeholder@127.0.0.1:29999/offline?sslmode=disable",
});
env.E2E_PLANNER_JOBS_DIR = join(ROOT, "e2e/test-results/planner-jobs");
env.E2E_JEV_CONTROL_DIR = join(ROOT, "e2e/test-results/jev-control");

let code = `
import { ROOT } from "./e2e/servers";
import { registerScriptedHarness } from "./e2e/harness/scripted-register";
let denied = () => { throw new Error("Discovery must not open a listener or fetch"); };
globalThis.fetch = denied;
Bun.serve = denied;
await registerScriptedHarness(process.env, ROOT);
await import("./apps/server/src/harness/agents");
if (globalThis.fetch !== denied || Bun.serve !== denied) throw new Error("Registration changed transport");
console.log("scripted-discovery-ready");
`;

test("scripted registration permits agent discovery without starting transport", async () => {
	let child = Bun.spawn([process.execPath, "--no-env-file", "-e", code], {
		cwd: ROOT,
		env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	let ready = Promise.withResolvers<void>();
	let stdout = "";
	let output = (async () => {
		let reader = child.stdout.getReader();
		let decoder = new TextDecoder();
		while (true) {
			let { done, value } = await reader.read();
			if (done) break;
			stdout += decoder.decode(value, { stream: true });
			if (stdout.includes("scripted-discovery-ready\n")) ready.resolve();
		}
		stdout += decoder.decode();
		if (!stdout.includes("scripted-discovery-ready\n")) {
			ready.reject(new Error(`Discovery exited before ready: ${stdout}`));
		}
		return stdout;
	})();
	void output.catch(ready.reject);
	// Cold module discovery competes with the full unit suite; only a ready child must exit promptly.
	let timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
	try {
		await ready.promise;
		clearTimeout(timer);
		timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
		let [exit, completeOutput, stderr] = await Promise.all([
			child.exited,
			output,
			new Response(child.stderr).text(),
		]);
		expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
		expect(completeOutput.trim()).toBe("scripted-discovery-ready");
	} finally {
		clearTimeout(timer);
		if (child.exitCode === null) child.kill("SIGKILL");
	}
}, 70_000);
