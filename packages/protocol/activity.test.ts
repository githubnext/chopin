import { expect, test } from "bun:test";

import { activityText } from "./activity";

let COMMAND = "sleep 900; git -C $CHOPIN_RUN_WORKTREES/rewire-handler status --short";

test("a shell command reads as running a command, not as the command", () => {
	expect(activityText(COMMAND, "execute")).toBe("Running a command");
	expect(activityText("cargo test -p backend", "execute")).toBe("Running a command");
	expect(activityText("bun test", "execute")).toBe("Running a command");
	// Without the tool's kind, as from an older connector, shell syntax still gives it away.
	expect(activityText(COMMAND)).toBe("Running a command");
	expect(activityText("GITHUB_TOKEN=abc npm publish")).toBe("Running a command");
});

test("an agent's own description of its step is kept", () => {
	expect(activityText("Running server tests", "execute")).toBe("Running server tests");
	expect(activityText("Opening the pull request")).toBe("Opening the pull request");
	expect(activityText("workflow: run prove", "other")).toBe("workflow: run prove");
	expect(activityText("  Checking   test\nresults ")).toBe("Checking test results");
});

test("secret-looking text and long text never reach the progress line", () => {
	let token = `ghp_${"a1B2c3D4".repeat(5)}`;
	expect(activityText(`Pushing with ${token}`)).toBe("Working");
	expect(activityText(`Pushing with ${token}`, "execute")).toBe("Running a command");
	expect(activityText("Calling the API with Bearer abcdefgh12345678")).toBe("Working");
	expect(activityText(`Reading ${"x".repeat(48)}`)).toBe("Working");
	let long = activityText(`Reading ${"the plan and its tasks ".repeat(10)}`)!;
	expect(long.length).toBeLessThanOrEqual(80);
	expect(long.endsWith("…")).toBe(true);
	expect(activityText("   ")).toBeUndefined();
});
