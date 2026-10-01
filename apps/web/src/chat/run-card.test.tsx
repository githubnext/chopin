import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { defaultOpen, orderRuns, RunStack, visibleRuns } from "./run-card";

import type { Chat as Wire } from "@chopin/protocol";

function run(id: string, status: Wire.Run["status"], started: number, waiting = 0): Wire.Run {
	return {
		id,
		name: id,
		status,
		started,
		updated: started + 60,
		...(["finished", "blocked", "failed", "stopped"].includes(status)
			? { ended: started + 60 }
			: {}),
		stages: [{
			id: `${id}:stage`,
			name: `${id}-stage`,
			status: status === "waiting" ? "awaiting_input" : "running",
			started,
		}],
		waiting,
	};
}

test("runs order by who needs attention, newest first within each group", () => {
	let runs = [
		run("old-done", "finished", 100),
		run("live", "running", 300),
		run("held", "paused", 400),
		run("asking", "waiting", 200, 1),
		run("new-done", "stopped", 500),
		run("newer-live", "running", 600),
	];
	expect(orderRuns(runs).map(item => item.id)).toEqual([
		"asking",
		"newer-live",
		"live",
		"held",
		"new-done",
		"old-done",
	]);
	expect(defaultOpen(orderRuns(runs))).toBe("asking");
	expect(defaultOpen(orderRuns(runs.filter(item => item.status !== "waiting")))).toBe("newer-live");
	expect(defaultOpen(orderRuns([run("done", "finished", 1)]))).toBeUndefined();
});

test("folding keeps at least three rows and never hides a run waiting on people", () => {
	let many = orderRuns([
		run("a", "waiting", 1, 1),
		run("b", "waiting", 2, 1),
		run("c", "waiting", 3, 1),
		run("d", "waiting", 4, 1),
		run("e", "running", 5),
	]);
	expect(visibleRuns(many, false).map(item => item.id)).toEqual(["d", "c", "b", "a"]);
	expect(visibleRuns(many, true)).toHaveLength(5);
	expect(visibleRuns(orderRuns([run("x", "running", 1), run("y", "paused", 2)]), false))
		.toHaveLength(2);
});

test("a concurrent stack opens only the waiting run, offers per-run controls, and folds the rest", () => {
	let markup = renderToStaticMarkup(createElement(RunStack, {
		onPause: () => {},
		onResume: () => {},
		onShowDecisions: () => {},
		runs: [
			run("drafting", "running", 300),
			run("held", "paused", 200),
			run("asking", "waiting", 100, 2),
			run("done", "finished", 50),
		],
	}));
	expect(markup.match(/data-run-stage=/g)).toHaveLength(1);
	expect(markup).toContain("asking-stage");
	expect(markup).not.toContain("drafting-stage");
	expect(markup).toContain('aria-label="Pause asking"');
	expect(markup).toContain('aria-label="Pause drafting"');
	expect(markup).toContain('aria-label="Resume held"');
	expect(markup).toContain("Waiting on 2 Decisions");
	expect(markup).toContain("+1 more");
	expect(markup).not.toContain(">done<");
	expect(markup.indexOf('data-run-status="waiting"')).toBeLessThan(
		markup.indexOf('data-run-status="running"'),
	);
});
