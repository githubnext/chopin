import { expect, test } from "bun:test";
import { type RunReports, untilUnpaused } from "./runs";

test("an answer to a paused run's question is held until the run resumes, including child runs", async () => {
	let planner: RunReports = {
		runs: { active: [], paused: ["root"], cards: [] },
		rootOf: runId => runId === "child" ? "root" : runId,
	};
	let released: string[] = [];
	let controller = new AbortController();
	let held = untilUnpaused(planner, "child", controller.signal).then(() => released.push("child"));
	await untilUnpaused(planner, "other", controller.signal).then(() => released.push("other"));
	await new Promise(resolve => setTimeout(resolve, 0));
	expect(released).toEqual(["other"]);
	planner.runs = { active: ["root"], paused: [], cards: [] };
	for (let wake of planner.waiters ?? []) wake();
	await held;
	expect(released).toEqual(["other", "child"]);

	planner.runs = { active: [], paused: ["root"], cards: [] };
	let aborted = new AbortController();
	let pending = untilUnpaused(planner, "root", aborted.signal);
	aborted.abort();
	await pending;
	expect(planner.waiters?.size ?? 0).toBe(0);
});
