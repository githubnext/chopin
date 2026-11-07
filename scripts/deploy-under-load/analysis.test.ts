import { describe, expect, it } from "bun:test";

import {
	buildProblems,
	checkEdits,
	checkTurns,
	excuseFailures,
	gates,
	outcomeOf,
	parseCut,
	parseReady,
	summarize,
} from "./analysis";

import type { Sample } from "../overlap";
import type { BuildOutcome, Measures, Request } from "./analysis";

describe("summarize", () => {
	it("reads the least, median, 95th percentile and greatest, and nothing from no values", () => {
		expect(summarize([])).toEqual({ count: 0, min: 0, p50: 0, p95: 0, max: 0 });
		let values = Array.from({ length: 100 }, (_, index) => index + 1);
		expect(summarize(values.toReversed())).toEqual({
			count: 100,
			min: 1,
			p50: 51,
			p95: 96,
			max: 100,
		});
	});
});

describe("what a process logs about its cut", () => {
	let log = [
		"chopin: 7 readiness check(s) answered not ready in the 300 ms window",
		"chopin: closing GET /api/slow, still running after 1000 ms, without an answer",
		"chopin: cut finished (unready 301 ms, listener 2 ms, requests 1001 ms, commit 40 ms, linkState 3 ms, release 5 ms, close 12 ms)",
	].join("\n");

	it("reads the phases, the readiness checks refused and the requests closed", () => {
		expect(parseCut(log)).toEqual({
			phases: {
				unready: 301,
				listener: 2,
				requests: 1001,
				commit: 40,
				linkState: 3,
				release: 5,
				close: 12,
			},
			refused: 7,
			noProxyCheck: false,
			abandoned: ["GET /api/slow"],
		});
	});

	it("notices a proxy that never checked readiness", () => {
		let cut = parseCut(
			"chopin: no readiness check was answered during the 300 ms before the listener stopped",
		);
		expect(cut.noProxyCheck).toBe(true);
		expect(cut.refused).toBeUndefined();
	});

	it("reads how long the new process took to be ready after the lease", () => {
		expect(
			parseReady(
				"chopin: ready 87 ms after taking the writer lease (reset 4 ms, experiments 12 ms)",
			),
		).toEqual({ afterLeaseMs: 87, phases: { reset: 4, experiments: 12 } });
		expect(parseReady("chopin: standby")).toBeUndefined();
	});
});

describe("the stored document against what clients typed", () => {
	let typed = { ed0: ["e0n0", "e0n1", "e0n2"], ed1: ["e1n0", "e1n1"] };

	it("holds when every token is there once and in order", () => {
		let source = "# Title\n\ned0 e0n0 e0n1 e0n2\n\ned1 e1n0 e1n1\n";
		expect(
			checkEdits(source, typed).every(item =>
				!item.lost.length && !item.duplicated.length && item.ordered
			),
		)
			.toBe(true);
	});

	it("names a lost token, a doubled one and an order that changed", () => {
		let source = "# Title\n\ned0 e0n0 e0n2\n\ned1 e1n1 e1n0 e1n0\n";
		let [first, second] = checkEdits(source, typed);
		expect(first).toMatchObject({ lost: ["e0n1"], duplicated: [], ordered: true });
		expect(second).toMatchObject({ lost: [], duplicated: ["e1n0"], ordered: false });
	});

	it("loses every token of a paragraph that is gone", () => {
		expect(checkEdits("# Title\n", { ed2: ["e2n0"] })[0]).toMatchObject({ lost: ["e2n0"] });
	});
});

function request(partial: Partial<Request> & Pick<Request, "kind">): Request {
	return { document: "d1", acknowledged: true, retries: 0, sentAt: 0, ...partial };
}

describe("every acknowledged request is started exactly once", () => {
	let requests = [
		request({ kind: "composer", tag: "x1" }),
		request({ kind: "comment", tag: "x2" }),
		request({ kind: "draft" }),
	];
	let rows = [
		{ document: "d1", kind: "composer", state: "ended" },
		{ document: "d1", kind: "comment", state: "ended" },
		{ document: "d1", kind: "draft", state: "ended" },
	];
	let prompts = [{ document: "d1", tag: "x1" }, { document: "d1", tag: "x2" }, { document: "d1" }];

	it("accepts one prompt per tagged request and one per turn that began", () => {
		let check = checkTurns(requests, rows, prompts);
		expect(check.misdelivered).toEqual([]);
		expect(check.turnsDiffer).toEqual([]);
		expect(check.unsettled).toBe(0);
		expect(check.acknowledged).toEqual({ composer: 1, comment: 1, draft: 1 });
	});

	it("names a request that was quoted twice and one that never was", () => {
		let check = checkTurns(
			requests,
			rows,
			[{ document: "d1", tag: "x1" }, { document: "d1", tag: "x1" }, { document: "d1" }],
		);
		expect(check.misdelivered).toEqual([{ tag: "x1", times: 2 }, { tag: "x2", times: 0 }]);
		expect(check.turnsDiffer).toEqual([]);
	});

	it("counts rows left waiting, cancelled and interrupted, and requests nobody answered", () => {
		let check = checkTurns(
			[
				...requests,
				request({ kind: "invoke", tag: "x3", acknowledged: false, refusal: "planner-queue-full" }),
			],
			[...rows, { document: "d1", kind: "invoke", state: "waiting" }, {
				document: "d1",
				kind: "invoke",
				state: "cancelled",
			}, { document: "d1", kind: "system", state: "interrupted" }],
			prompts,
		);
		expect(check.unsettled).toBe(1);
		expect(check.cancelled).toBe(1);
		expect(check.interrupted).toBe(1);
		expect(check.unacknowledged).toEqual(["invoke x3 planner-queue-full"]);
		expect(check.turnsDiffer).toEqual([{ document: "d1", rows: 4, prompts: 3 }]);
	});
});

const BUILD_GATE =
	"a build that ran across the deploys finished Built, with a pull request for every task";
const RAW_FAILURES_GATE =
	"no request through the proxy was refused, apart from one still running at the in-flight bound";
const WINDOW = { from: 4_000, to: 6_000 };

function sample(method: string, path: string, status: number | undefined, endedAt: number): Sample {
	return { method, path, status, startedAt: endedAt - 800, endedAt };
}

function built(changes: Partial<BuildOutcome> = {}): BuildOutcome {
	return {
		state: "stopped",
		tasks: [
			{ id: "connect", state: "completed", pullRequest: "https://example.test/pr/1" },
			{ id: "review", state: "completed", pullRequest: "https://example.test/pr/2" },
		],
		expected: ["connect", "review"],
		pullRequests: 2,
		...changes,
	};
}

const progress = (...tasks: Array<[string, string, string?]>) => ({
	tasks: tasks.map(([id, state, url]) => ({
		id,
		state,
		...(url ? { pullRequest: { url } } : {}),
	})),
});

describe("how a build ended", () => {
	it("reads the state and what the last run reported, counting each pull request once", () => {
		let outcome = outcomeOf({
			build: { state: "stopped" },
			lifecycle: {
				history: [{
					progress: progress(["connect", "completed", "pr/1"], ["review", "completed", "pr/1"]),
				}],
			},
		}, ["connect", "review"]);
		expect(outcome).toEqual({
			state: "stopped",
			tasks: [
				{ id: "connect", state: "completed", pullRequest: "pr/1" },
				{ id: "review", state: "completed", pullRequest: "pr/1" },
			],
			expected: ["connect", "review"],
			pullRequests: 1,
		});
		expect(buildProblems(outcome)).toEqual(["1 pull request(s) delivered for 2 task(s)"]);
	});

	it("takes a build with no report, or no build at all, for one that did not finish", () => {
		expect(outcomeOf({ build: { state: "stopped" } }, ["connect"])).toMatchObject({
			state: "stopped",
			tasks: [],
			pullRequests: 0,
		});
		expect(buildProblems(outcomeOf({ build: { state: "stopped" } }, ["connect"]))).toContain(
			"task connect was never reported",
		);
		expect(outcomeOf({}, ["connect"]).state).toBe("missing");
	});
});

describe("which failures the cut explains", () => {
	it("excuses a failure that is a request the old process closed at its bound, once each, and no other", () => {
		let closed = ["POST /api/channels/x/poll", "POST /api/channels/x/poll"];
		let result = excuseFailures(
			[
				sample("POST", "/api/channels/x/poll", 502, 4_900),
				sample("POST", "/api/channels/x/poll", undefined, 5_000),
				// A third failure of the same request, with only two closed, is not explained.
				sample("POST", "/api/channels/x/poll", 502, 5_100),
			],
			closed,
			WINDOW,
		);
		expect(result.excused).toHaveLength(2);
		expect(result.unexplained).toHaveLength(1);
	});

	it("explains nothing for a failure of another request, of a GET, with another answer, or outside the cut", () => {
		let closed = ["POST /api/poll", "GET /api/poll"];
		let result = excuseFailures(
			[
				// Another path.
				sample("POST", "/api/session", 502, 5_000),
				// A GET is tried again on the new process, so it should not have failed.
				sample("GET", "/api/poll", 502, 5_000),
				// The old process refusing it is not a close without an answer.
				sample("POST", "/api/poll", 503, 5_000),
				// Before the old process said it was stopping, and long after it released.
				sample("POST", "/api/poll", 502, 3_000),
				sample("POST", "/api/poll", 502, 9_000),
			],
			closed,
			WINDOW,
		);
		expect(result.excused).toEqual([]);
		expect(result.unexplained).toHaveLength(5);
	});

	it("takes a query off the path before it compares", () => {
		let result = excuseFailures(
			[sample("POST", "/api/poll?wait=30", 502, 5_000)],
			["POST /api/poll"],
			WINDOW,
		);
		expect(result.excused).toHaveLength(1);
	});
});

const clean = (): Measures => ({
	budgetMs: 750,
	graceMs: 1_500,
	quietMs: 5_000,
	maxGapMs: 750,
	handOvers: [{
		exit: 0,
		gapMs: 240,
		failed: [],
		closedByCut: [],
		cutWindow: WINDOW,
		readinessRefused: 5,
		noProxyCheck: false,
		longestLossMs: 600,
		notices: 0,
		pastGrace: 0,
		resets: 0,
		plannerMisses: 0,
	}],
	edits: [{ marker: "ed0", typed: 3, lost: [], duplicated: [], ordered: true }],
	turns: {
		acknowledged: { composer: 1 },
		unacknowledged: [],
		misdelivered: [],
		turnsDiffer: [],
		rows: {},
		unsettled: 0,
		cancelled: 0,
		interrupted: 0,
	},
	mcp: { calls: 10, failures: 0 },
	connector: { withdrawn: 0 },
	api: { calls: 5, failures: 0 },
});

describe("the gates", () => {
	let failing = (measures: Measures) =>
		gates(measures).filter(item => !item.passed).map(item => item.name);

	it("passes a clean run", () => {
		expect(failing(clean())).toEqual([]);
	});

	it("fails a gap past the budget, a refused request, a notice and a lost word", () => {
		let measures = clean();
		measures.handOvers[0]!.gapMs = 1_190;
		measures.handOvers[0]!.failed = [sample("GET", "/api/session", 502, 5_000)];
		measures.handOvers[0]!.notices = 1;
		measures.edits[0]!.lost = ["e0n1"];
		expect(failing(measures)).toEqual([
			"first request served within 750 ms of the release (design budget 750 ms)",
			RAW_FAILURES_GATE,
			"no client was without its document longer than a tab waits before saying so (5000 ms for a restart it was told of, 1500 ms otherwise)",
			"every word typed is in the stored document exactly once, in order",
		]);
	});

	it("does not gate a reconnect past the design's grace that a tab would still say nothing about", () => {
		let measures = clean();
		measures.handOvers[0]!.pastGrace = 4;
		measures.handOvers[0]!.longestLossMs = 1_700;
		expect(failing(measures)).toEqual([]);
		let detail =
			gates(measures).find(item => item.name.startsWith("no client was without"))!.detail;
		expect(detail).toContain("4 reconnect(s) past the design's 1500 ms grace");
	});

	it("allows a request that was still running at the in-flight bound when the cut closed it, and no more", () => {
		let measures = clean();
		let item = measures.handOvers[0]!;
		item.failed = [sample("POST", "/api/channels/x/poll", 502, 5_000)];
		item.closedByCut = ["POST /api/channels/x/poll"];
		expect(failing(measures)).toEqual([]);
		// A second failure of it, with the cut having closed only one, is not explained.
		item.failed.push(sample("POST", "/api/channels/x/poll", 502, 5_100));
		expect(failing(measures)).toEqual([RAW_FAILURES_GATE]);
	});

	it("fails a real failure beside an unrelated request the cut closed in the same hand-over", () => {
		let measures = clean();
		let item = measures.handOvers[0]!;
		item.failed = [sample("POST", "/api/session", 502, 5_000)];
		item.closedByCut = ["POST /api/channels/x/poll"];
		expect(failing(measures)).toEqual([RAW_FAILURES_GATE]);
		expect(gates(measures).find(gate => gate.name === RAW_FAILURES_GATE)!.detail).toContain(
			"unexplained: POST /api/session 502",
		);
	});

	it("fails a hand-over that never served again, an old process that did not exit 0 and a run with no MCP calls", () => {
		let measures = clean();
		measures.handOvers[0]!.gapMs = undefined;
		measures.handOvers[0]!.exit = 1;
		measures.mcp.calls = 0;
		expect(failing(measures)).toHaveLength(3);
	});

	it("gates a build only when the run made one, and only a build that finished Built passes", () => {
		let measures = clean();
		expect(failing(measures)).toEqual([]);
		measures.build = built();
		expect(failing(measures)).toEqual([]);
		measures.build = built({ state: "failed", error: "The agent did not start." });
		expect(failing(measures)).toEqual([BUILD_GATE]);
	});

	it("does not take any stopped run for a build that finished: a stopped build that completed no task, has no pull request, or reported fewer than it was given fails", () => {
		let measures = clean();
		for (
			let outcome of [
				built({ tasks: [] }),
				built({ tasks: [{ id: "connect", state: "completed", pullRequest: "pr/1" }] }),
				built({
					tasks: [
						{ id: "connect", state: "completed", pullRequest: "pr/1" },
						{ id: "review", state: "blocked" },
					],
				}),
				built({
					tasks: [
						{ id: "connect", state: "completed", pullRequest: "pr/1" },
						{ id: "review", state: "completed" },
					],
				}),
				built({ pullRequests: 1 }),
				built({ error: "The run ended early." }),
			]
		) {
			measures.build = outcome;
			expect(failing(measures), JSON.stringify(outcome)).toEqual([BUILD_GATE]);
		}
		expect(buildProblems(built({ state: "running" }))).toEqual(["it ended running, not stopped"]);
	});
});
