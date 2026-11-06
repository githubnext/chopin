import { expect, test } from "bun:test";

import { cut } from "./cut";

import type { CutSteps } from "./cut";

function recorder(overrides: Partial<CutSteps> = {}) {
	let events: string[] = [];
	let at: Record<string, number> = {};
	let note = (name: string) => {
		events.push(name);
		at[name] = Math.round(performance.now());
	};
	let steps: CutSteps = {
		unready: () => note("unready"),
		refused: () => {
			note("refused");
			return 3;
		},
		stopListening: async () => note("stopListening"),
		finishRequests: async () => {
			note("finishRequests");
			return [];
		},
		commit: async () => note("commit"),
		persistLinkState: async () => note("persistLinkState"),
		release: async () => note("release"),
		closeClients: async () => note("closeClients"),
		...overrides,
	};
	return { steps, events, at };
}

const QUIET = { info() {}, warn() {} };

test("the steps run in the cut's order: readiness off, listener, requests, commit, link state, release, then sockets", async () => {
	let { steps, events } = recorder();
	await cut(steps, { unreadyMs: 5, requestWaitMs: 100 }, QUIET);
	expect(events).toEqual([
		"unready",
		"refused",
		"stopListening",
		"finishRequests",
		"commit",
		"persistLinkState",
		"release",
		"closeClients",
	]);
});

test("readiness stays off for the whole unready window before the listener stops, and not longer", async () => {
	let { steps, at } = recorder();
	await cut(steps, { unreadyMs: 120, requestWaitMs: 100 }, QUIET);
	let window = at.stopListening! - at.unready!;
	expect(window).toBeGreaterThanOrEqual(115);
	expect(window).toBeLessThan(260);
});

test("it logs how many readiness checks the window answered, and a window with none as a risk", async () => {
	let lines: string[] = [];
	let log = {
		info: (line: string) => lines.push(`info ${line}`),
		warn: (line: string) => lines.push(`warn ${line}`),
	};
	await cut(recorder().steps, { unreadyMs: 1, requestWaitMs: 1 }, log);
	expect(lines[0]).toContain("info chopin: 3 readiness check(s)");
	let none = recorder({ refused: () => 0 });
	lines.length = 0;
	let report = await cut(none.steps, { unreadyMs: 1, requestWaitMs: 1 }, log);
	expect(report.refused).toBe(0);
	expect(lines[0]).toStartWith("warn chopin: no readiness check was answered");
	expect(none.events).toContain("stopListening");
});

test("it hands the request bound to the step, and logs each request still running at it", async () => {
	let lines: string[] = [];
	let seen: number[] = [];
	let { steps } = recorder({
		finishRequests: async bound => {
			seen.push(bound);
			return ["POST /api/connector/poll", "GET /slow"];
		},
	});
	let report = await cut(steps, { unreadyMs: 0, requestWaitMs: 750 }, {
		info() {},
		warn: line => lines.push(line),
	});
	expect(seen).toEqual([750]);
	expect(report.abandoned).toEqual(["POST /api/connector/poll", "GET /slow"]);
	expect(lines).toHaveLength(2);
	expect(lines[0]).toContain("POST /api/connector/poll");
});

test("a failing step is recorded and the rest still run, so the lease is released and sockets close", async () => {
	let { steps, events } = recorder({
		commit: async () => {
			throw new Error("commit failed");
		},
	});
	let report = await cut(steps, { unreadyMs: 0, requestWaitMs: 1 }, QUIET);
	expect(report.errors.map(error => error.message)).toEqual(["commit failed"]);
	expect(events.slice(-3)).toEqual(["persistLinkState", "release", "closeClients"]);
});

test("a zero window does not wait, and the report says how long each phase took", async () => {
	let { steps } = recorder();
	let started = performance.now();
	let report = await cut(steps, { unreadyMs: 0, requestWaitMs: 0 }, QUIET);
	expect(performance.now() - started).toBeLessThan(100);
	expect(Object.keys(report.phases)).toEqual([
		"unready",
		"listener",
		"requests",
		"commit",
		"linkState",
		"release",
		"close",
	]);
});
