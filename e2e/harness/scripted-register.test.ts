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
	let timer = setTimeout(() => child.kill("SIGKILL"), 8000);
	try {
		let [exit, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
		expect(stdout.trim()).toBe("scripted-discovery-ready");
	} finally {
		clearTimeout(timer);
	}
}, 10_000);
