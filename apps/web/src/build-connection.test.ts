import { expect, test } from "bun:test";
import { plannerConnectCommand } from "./build-connection";

test("a Planner connection waits for a backend and preserves its exact command and document", () => {
	let url = "https://chopin.example/githubnext/chopin/cache-plan";
	expect(plannerConnectCommand(url, "  ")).toBe("");
	expect(plannerConnectCommand(url, 'planner --label="Cache plan"')).toBe(
		`CHOPIN_URL=https://chopin.example chopin connect . --planner ${url}`
			+ ` --planner-command 'planner --label="Cache plan"' -- copilot --acp --allow-all`,
	);
});

test("backend shell characters stay inside one literal argument", () => {
	expect(plannerConnectCommand("https://chopin.example/o/r/plan", "planner 'quoted' $(whoami)"))
		.toContain("--planner-command 'planner '\\''quoted'\\'' $(whoami)'");
});
