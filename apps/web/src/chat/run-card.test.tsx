import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
	defaultOpen,
	displayStages,
	elapsed,
	orderRuns,
	RunStack,
	stageWindow,
	visibleRuns,
} from "./run-card";

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

test("a tool step carries the wrench and says it is a tool step", () => {
	let tooled = run("demo", "running", 10);
	tooled.stages = [{
		id: "demo:t1",
		name: "prepare",
		kind: "tool",
		status: "running",
		started: 10,
	}];
	let markup = renderToStaticMarkup(createElement(RunStack, { runs: [tooled] }));
	expect(markup).toContain('<span class="sr-only">tool step: </span>prepare');
	expect(markup).toContain("data-nucleo-icon");
	let plain = renderToStaticMarkup(
		createElement(RunStack, { runs: [run("agent", "running", 10)] }),
	);
	expect(plain).not.toContain("tool step");
});

test("runs of the same workflow are told apart by a short run id", () => {
	let first = { ...run("aaaaaaaa-1111", "running", 10), name: "demo-wait" };
	let second = { ...run("bbbbbbbb-2222", "running", 20), name: "demo-wait" };
	let markup = renderToStaticMarkup(
		createElement(RunStack, { onPause: () => {}, runs: [first, second] }),
	);
	expect(markup).toContain('aria-label="Pause demo-wait aaaaaaaa"');
	expect(markup).toContain('aria-label="Pause demo-wait bbbbbbbb"');
	let single = renderToStaticMarkup(createElement(RunStack, { onPause: () => {}, runs: [first] }));
	expect(single).toContain('aria-label="Pause demo-wait"');
});

test("a failed stage stops unfinished descendants without changing completed work or siblings", () => {
	let nested = {
		...run("nested", "running", 10),
		stages: [
			{ id: "parent", name: "parent", status: "failed" as const },
			{ id: "running", name: "running", status: "running" as const, parentIds: ["parent"] },
			{ id: "queued", name: "queued", status: "pending" as const, parentIds: ["running"] },
			{ id: "done", name: "done", status: "completed" as const, parentIds: ["parent"] },
			{ id: "sibling", name: "sibling", status: "running" as const },
		],
	};
	let markup = renderToStaticMarkup(createElement(RunStack, { runs: [nested] }));
	expect([...markup.matchAll(/data-run-stage="([^"]+)"/g)].map(match => match[1])).toEqual([
		"failed",
		"stopped",
		"stopped",
		"completed",
		"running",
	]);
	expect(markup.match(/data-run-pulse=/g)).toHaveLength(2);
});

test("stopped parents stop running and pending descendants, keeping their finished outcomes", () => {
	let nested = run("nested", "running", 10);
	nested.stages = [
		{ id: "parent", name: "parent", status: "stopped" },
		{ id: "running", name: "running", status: "running", parentIds: ["parent"] },
		{ id: "queued", name: "queued", status: "pending", parentIds: ["parent"] },
		{ id: "done", name: "done", status: "completed", parentIds: ["parent"] },
		{ id: "failed", name: "failed", status: "failed", parentIds: ["parent"] },
	];
	expect(displayStages(nested).map(stage => stage.status)).toEqual([
		"stopped",
		"stopped",
		"stopped",
		"completed",
		"failed",
	]);
	expect(nested.stages[1]!.status).toBe("running");
	for (let status of ["stopped", "failed", "blocked"] as const) {
		let ended = {
			...nested,
			status,
			stages: nested.stages.map(({ parentIds: _, ...stage }) => stage),
		};
		expect(displayStages(ended).map(stage => stage.status)).toEqual([
			"stopped",
			"stopped",
			"stopped",
			"completed",
			"failed",
		]);
	}
});

test("elapsed switches to days instead of printing hundreds of hours", () => {
	expect(elapsed(2)).toBe("2s");
	expect(elapsed(35 * 60)).toBe("35m");
	expect(elapsed(23 * 3600 + 59 * 60)).toBe("23h 59m");
	expect(elapsed(24 * 3600)).toBe("1d 0h");
	expect(elapsed(3 * 86_400 + 4 * 3600)).toBe("3d 4h");
	expect(elapsed(497_550 * 3600)).toBe("20731d 6h");
});

function longRun(count: number, earlierStages?: number): Wire.Run {
	let long = run("long", "running", 10);
	long.stages = Array.from({ length: count }, (_, index) => ({
		id: `long:s${index}`,
		name: `stage-${index}`,
		status: index === count - 1 ? "running" as const : "completed" as const,
		started: 10 + index,
	}));
	if (earlierStages) long.earlierStages = earlierStages;
	return long;
}

test("a long run folds to its latest stages behind a real button that names what it shows", () => {
	let folded = stageWindow(longRun(16, 4), false);
	expect(folded.stages.map(stage => stage.name)).toEqual([
		"stage-10",
		"stage-11",
		"stage-12",
		"stage-13",
		"stage-14",
		"stage-15",
	]);
	expect(folded).toMatchObject({ earlier: 14, unreported: 4 });
	let markup = renderToStaticMarkup(createElement(RunStack, { runs: [longRun(16, 4)] }));
	let button = /<button[^>]*data-run-earlier=""[^>]*>(.*?)<\/button>/.exec(markup);
	expect(button?.[0]).toContain('aria-expanded="false"');
	expect(button?.[0]).toContain('aria-controls="run-stage-list-long"');
	expect(button?.[1]?.replace(/<[^>]+>/g, "")).toBe("+Show 14 earlier stages");
	expect(markup.match(/data-run-stage=/g)).toHaveLength(6);
});

test("expanding lists every reported stage and says how many the run never reported", () => {
	let open = stageWindow(longRun(16, 4), true);
	expect(open.stages.map(stage => stage.name)).toEqual(
		Array.from({ length: 16 }, (_, index) => `stage-${index}`),
	);
	expect(open).toMatchObject({ earlier: 14, unreported: 4 });
	expect(stageWindow(longRun(16), true).unreported).toBe(0);
	expect(stageWindow(longRun(16), false).stages).toHaveLength(6);
});

test("collapsing returns to the latest stages, and a short run has nothing to expand", () => {
	let long = longRun(16);
	expect(stageWindow(long, true).stages.length).toBeGreaterThan(
		stageWindow(long, false).stages.length,
	);
	let short = stageWindow(longRun(4), false);
	expect(short).toMatchObject({ earlier: 0, unreported: 0 });
	expect(short.stages).toHaveLength(4);
	let markup = renderToStaticMarkup(createElement(RunStack, { runs: [longRun(4)] }));
	expect(markup).not.toContain("data-run-earlier");
	expect(markup).not.toContain("earlier");
});

test("nested stages keep their parents and stopped descendants on both sides of the fold", () => {
	let nested = longRun(16);
	nested.stages[1] = { id: "long:s1", name: "stage-1", status: "failed", started: 11 };
	nested.stages[2] = {
		id: "long:s2",
		name: "stage-2",
		status: "running",
		started: 12,
		parentIds: ["long:s1"],
	};
	nested.stages[14] = {
		id: "long:s14",
		name: "stage-14",
		status: "pending",
		parentIds: ["long:s2"],
	};
	nested.stages[15] = { ...nested.stages[15]!, parentIds: ["long:s0"] };
	let folded = stageWindow(nested, false).stages;
	let open = stageWindow(nested, true).stages;
	expect(folded.find(stage => stage.id === "long:s14")?.status).toBe("stopped");
	expect(open.find(stage => stage.id === "long:s14")).toMatchObject({
		status: "stopped",
		parentIds: ["long:s2"],
	});
	expect(open.find(stage => stage.id === "long:s2")).toMatchObject({
		status: "stopped",
		parentIds: ["long:s1"],
	});
	expect(open.find(stage => stage.id === "long:s15")?.status).toBe("running");
	let order = open.map(stage => stage.id);
	for (let stage of open) {
		for (let parent of stage.parentIds ?? []) {
			expect(order.indexOf(parent)).toBeLessThan(order.indexOf(stage.id));
		}
	}
});

test("a run whose earlier stages all went unreported still offers the expand button", () => {
	let markup = renderToStaticMarkup(createElement(RunStack, { runs: [longRun(3, 9)] }));
	let button = /<button[^>]*data-run-earlier=""[^>]*>(.*?)<\/button>/.exec(markup);
	expect(button?.[0]).toContain('aria-expanded="false"');
	expect(button?.[1]?.replace(/<[^>]+>/g, "")).toBe("+Show 9 earlier stages");
	let open = stageWindow(longRun(3, 9), true);
	expect(open).toMatchObject({ earlier: 9, unreported: 9 });
	expect(open.stages).toHaveLength(3);
});
