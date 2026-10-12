import { describe, expect, it } from "bun:test";

import {
	advanceFirstBuild,
	ago,
	attentionHint,
	buildLabel,
	buildLook,
	buildPhase,
	buildTabReady,
	draftRefusalCopy,
	elapsed,
	firstBuildStep,
	pullRequestCommits,
	pullRequestNumber,
	startedBy,
	startingHint,
	syncHint,
	syncStatus,
	taskStartsOpen,
} from "./build-model";

import type {
	BuildRequest,
	ImplementationSnapshot,
	LiveSnapshot,
} from "@chopin/protocol/implementation";

type History = ImplementationSnapshot["lifecycle"]["history"][number];

function snapshot(change: Partial<ImplementationSnapshot> = {}): ImplementationSnapshot {
	return {
		revision: 1,
		planRevision: 4,
		graph: {
			number: 2,
			revision: 3,
			planRevision: 4,
			state: "draft",
			definition: {
				tasks: [{
					id: "a",
					title: "First",
					context: "",
					goal: "Do it",
					acceptance: [],
					dependsOn: [],
				}],
			},
		},
		localAgent: false,
		blockers: [],
		buildReady: true,
		lifecycle: { execution: { state: "idle" }, history: [] },
		...change,
	};
}

function build(state: BuildRequest["state"]): BuildRequest {
	return {
		id: "b",
		user: "u",
		connectionId: "c",
		repositoryId: "r",
		checkout: { repository: "o/r", commit: "0".repeat(40) },
		planRevision: 4,
		graphVersion: 2,
		graphRevision: 3,
		createdAt: "2026-10-10T10:00:00.000Z",
		expiresAt: 0,
		state,
	};
}

function run(outcome: History["outcome"], pullRequests = 0): History {
	return {
		run: {
			id: "b",
			user: "u",
			client: { name: "c", version: "1" },
			session: "s",
			planRevision: 4,
			graphVersion: 2,
			graphRevision: 3,
			repository: "o/r",
			branch: "main",
			commit: "0".repeat(40),
			startedAt: "2026-10-10T10:00:00.000Z",
		},
		progress: {
			tasks: Array.from({ length: pullRequests }, (_, index) => ({
				id: `t${index}`,
				state: "completed" as const,
				pullRequest: { url: `https://github.com/o/r/pull/${index + 1}`, state: "open" as const },
			})),
			events: [],
		},
		outcome,
	};
}

describe("buildPhase", () => {
	it("loads before the first snapshot", () => {
		expect(buildPhase(undefined)).toEqual({ kind: "loading" });
	});

	it("drafts when there are no tasks, the tasks are stale, or a build was returned", () => {
		expect(buildPhase(snapshot({ graph: undefined }))).toEqual({
			kind: "drafting",
			draft: "prepare",
		});
		expect(buildPhase(snapshot({ planRevision: 5 }))).toEqual({
			kind: "drafting",
			draft: "revise",
		});
		expect(buildPhase(snapshot({
			build: build("stopped"),
			lifecycle: {
				execution: { state: "idle" },
				history: [run({ kind: "revision_requested", reason: "Split it" })],
			},
		}))).toEqual({ kind: "drafting", draft: "returned" });
	});

	it("names each blocker before drafting", () => {
		expect(buildPhase(snapshot({
			graph: undefined,
			blockers: ["unanswered questionnaires", "accepted comments awaiting plan changes"],
		}))).toEqual({ kind: "blocked", decisions: true, comments: true, stale: true });
		expect(buildPhase(snapshot({ blockers: ["invalid plan revision"] }))).toEqual({
			kind: "blocked",
			decisions: false,
			comments: false,
			stale: false,
		});
	});

	it("reviews current tasks", () => {
		expect(buildPhase(snapshot())).toEqual({ kind: "review" });
	});

	it("builds while a request is pending or the run is active", () => {
		for (let state of ["queued", "starting", "running"] as const) {
			expect(buildPhase(snapshot({ build: build(state) }))).toEqual({ kind: "building" });
		}
		expect(buildPhase(snapshot({
			lifecycle: { execution: { state: "active" }, history: [] },
		}))).toEqual({ kind: "building" });
	});

	it("separates a failure before the claim from a stop while the run holds the tasks", () => {
		expect(buildPhase(snapshot({ build: build("failed") }))).toEqual({ kind: "failed" });
		expect(buildPhase(snapshot({
			build: build("stopped"),
			lifecycle: { execution: { state: "active" }, history: [] },
		}))).toEqual({ kind: "stopped" });
	});

	it("counts distinct pull requests when done", () => {
		expect(buildPhase(snapshot({
			build: build("stopped"),
			lifecycle: { execution: { state: "idle" }, history: [run({ kind: "implemented" }, 2)] },
		}))).toEqual({ kind: "done", pullRequests: 2 });
	});
});

describe("presentation", () => {
	it("reads pull request numbers from their URLs", () => {
		expect(pullRequestNumber("https://github.com/o/r/pull/412")).toBe(412);
		expect(pullRequestNumber("https://github.com/o/r/pull/412/files")).toBe(412);
		expect(pullRequestNumber("https://example.test/elsewhere")).toBeUndefined();
	});

	it("shows elapsed time in minutes and hours", () => {
		let start = "2026-10-10T10:00:00.000Z";
		let at = (minutes: number) => Date.parse(start) + minutes * 60_000;
		expect(elapsed(start, at(0))).toBe("0m");
		expect(elapsed(start, at(38))).toBe("38m");
		expect(elapsed(start, at(65))).toBe("1h 5m");
		expect(elapsed(start, at(120))).toBe("2h");
		expect(elapsed("not a date", at(1))).toBeUndefined();
	});

	it("opens active, blocked and linked tasks", () => {
		expect(taskStartsOpen("in_progress", false)).toBe(true);
		expect(taskStartsOpen("blocked", false)).toBe(true);
		expect(taskStartsOpen("queued", false)).toBe(false);
		expect(taskStartsOpen("completed", true)).toBe(true);
	});
});

describe("attribution", () => {
	it("names the viewer as you and anyone else by login", () => {
		expect(startedBy(snapshot({ build: build("running") }), "u")).toBe("you");
		expect(startedBy(snapshot({ build: build("running"), startedBy: "ana" }), "v")).toBe("ana");
		expect(startedBy(snapshot({ build: build("running") }), "v")).toBeUndefined();
		expect(startedBy(snapshot(), "u")).toBeUndefined();
	});
});

describe("refusals", () => {
	it("explains the refusals the server names and leaves the rest to the failure line", () => {
		expect(draftRefusalCopy("resolve unanswered questionnaires first"))
			.toBe("Answer the open decisions first.");
		expect(draftRefusalCopy("implementation is already active")).toBe(
			"A build is already running.",
		);
		expect(draftRefusalCopy("the Planner queue is full"))
			.toBe("Chopin is busy with other requests. Try again shortly.");
		expect(draftRefusalCopy("not connected")).toBeUndefined();
		expect(draftRefusalCopy("could not save the request")).toBeUndefined();
	});
});

describe("first build", () => {
	let idle = { stage: "idle" } as const;
	let fresh = snapshot({ graph: undefined });

	it("stays idle until pressed, and reads a running build as working", () => {
		expect(firstBuildStep(fresh, idle)).toEqual({ view: "idle" });
		expect(firstBuildStep(snapshot(), idle)).toEqual({ view: "idle" });
		expect(firstBuildStep(undefined, idle)).toEqual({ view: "idle" });
		expect(firstBuildStep(snapshot({ build: build("failed") }), idle).view).toBe("idle");
		expect(firstBuildStep(snapshot({ build: build("running") }), idle).view).toBe("working");
	});

	it("retries a build that failed before it claimed its tasks from the same tasks", () => {
		let state = advanceFirstBuild(idle, { type: "press" });
		expect(firstBuildStep(snapshot({ build: build("failed") }), state).next).toBe("start");
	});

	it("drafts, then starts the drafted tasks without a review step", () => {
		let state = advanceFirstBuild(idle, { type: "press" });
		expect(firstBuildStep(fresh, state)).toEqual({ view: "working", next: "draft" });
		state = advanceFirstBuild(state, { type: "draft-sent" });
		expect(firstBuildStep(fresh, state)).toEqual({ view: "working" });
		// Tasks for an older revision are not the drafted ones.
		let stale = snapshot({ planRevision: 5 });
		expect(firstBuildStep(stale, state)).toEqual({ view: "working" });
		expect(firstBuildStep(snapshot(), state)).toEqual({ view: "working", next: "start" });
		state = advanceFirstBuild(state, { type: "start" });
		expect(state).toEqual({ stage: "starting" });
		expect(firstBuildStep(snapshot(), state)).toEqual({ view: "working" });
		state = advanceFirstBuild(state, { type: "started" });
		expect(firstBuildStep(snapshot(), state)).toEqual({ view: "working" });
		expect(firstBuildStep(snapshot({ build: build("queued") }), state))
			.toEqual({ view: "working", next: "reset" });
	});

	it("starts existing tasks for this revision at once", () => {
		let state = advanceFirstBuild(idle, { type: "press" });
		expect(firstBuildStep(snapshot(), state).next).toBe("start");
	});

	it("returns to the button when drafting or starting fails", () => {
		let sent = advanceFirstBuild(advanceFirstBuild(idle, { type: "press" }), {
			type: "draft-sent",
		});
		expect(advanceFirstBuild(sent, { type: "draft-ended", drafted: true })).toBe(sent);
		let failed = advanceFirstBuild(sent, { type: "draft-ended", drafted: false });
		expect(failed.stage).toBe("failed");
		expect(firstBuildStep(fresh, failed)).toEqual({ view: "idle" });
		expect(advanceFirstBuild(failed, { type: "press" })).toEqual({
			stage: "drafting",
			sent: false,
		});

		let starting = advanceFirstBuild(sent, { type: "start" });
		let noAgent = advanceFirstBuild(starting, { type: "start-refused", agent: true });
		expect(noAgent).toEqual({ stage: "failed", agent: true, message: undefined });
		expect(firstBuildStep(snapshot(), noAgent)).toEqual({ view: "idle" });
	});

	it("waits through a decision the draft raised, then redrafts and starts", () => {
		let requested = { buildRequested: { by: "me", revision: 4 } };
		let state = advanceFirstBuild(advanceFirstBuild(idle, { type: "press" }), {
			type: "draft-sent",
		});
		let blocked = snapshot({ blockers: ["unanswered questionnaires"], ...requested });
		expect(firstBuildStep(blocked, state, "me")).toEqual({ view: "waiting", next: "wait" });
		state = advanceFirstBuild(state, { type: "wait" });
		expect(state).toEqual({ stage: "waiting" });
		// The draft turn ending while blocked is not a failure.
		expect(advanceFirstBuild(state, { type: "draft-ended", drafted: false })).toBe(state);
		expect(firstBuildStep(blocked, state, "me")).toEqual({ view: "waiting" });
		// Answering moved the document on, so the tasks are stale: draft them again.
		let answered = snapshot({ planRevision: 5, ...requested });
		expect(firstBuildStep(answered, state, "me")).toEqual({ view: "working", next: "draft" });
		state = advanceFirstBuild(state, { type: "draft-sent" });
		expect(firstBuildStep(answered, state, "me")).toEqual({ view: "working" });
		let redrafted = snapshot({ ...requested });
		expect(firstBuildStep(redrafted, state, "me")).toEqual({ view: "working", next: "start" });
	});

	it("resumes a request the server kept across a reload", () => {
		let requested = { buildRequested: { by: "me", revision: 4 } };
		let blocked = snapshot({ blockers: ["unanswered questionnaires"], ...requested });
		expect(firstBuildStep(blocked, idle, "me")).toEqual({ view: "waiting", next: "resume" });
		expect(firstBuildStep(snapshot(requested), idle, "me"))
			.toEqual({ view: "working", next: "resume" });
		// Someone else's request, or one for a document since built, is not this viewer's to resume.
		expect(firstBuildStep(blocked, idle, "you").view).toBe("idle");
		expect(
			firstBuildStep(
				{
					...blocked,
					lifecycle: { ...blocked.lifecycle, history: [run({ kind: "implemented" })] },
				},
				idle,
				"me",
			).next,
		).toBeUndefined();
		let state = advanceFirstBuild(idle, { type: "resume" });
		expect(state).toEqual({ stage: "waiting" });
		expect(firstBuildStep(snapshot(requested), state, "me").next).toBe("start");
		// Cancelled: the request is gone, so the wait ends.
		expect(firstBuildStep(snapshot({ blockers: ["unanswered questionnaires"] }), state, "me"))
			.toEqual({ view: "idle", next: "reset" });
	});
});

const PR = "https://github.com/o/r/pull/7";

function live(change: Partial<LiveSnapshot> = {}): ImplementationSnapshot {
	return snapshot({
		live: {
			buildId: "b",
			user: "u",
			repositoryId: "r",
			checkout: { repository: "o/r", commit: "0".repeat(40) },
			baseRevision: 4,
			pullRequests: [PR],
			commits: [],
			tasks: [],
			outOfSync: false,
			builderConnected: true,
			...change,
		},
	});
}

function rebuild(state: BuildRequest["state"]): BuildRequest {
	return { ...build(state), id: "r1", kind: "rebuild", baseRevision: 4, targetRevision: 6 };
}

describe("living document sync", () => {
	it("is absent until the first build has delivered", () => {
		expect(syncStatus(snapshot())).toBeUndefined();
		expect(syncStatus(undefined)).toBeUndefined();
	});

	it("reads as in sync when the pull requests match the document", () => {
		expect(syncStatus(live())).toEqual({ kind: "in-sync" });
		expect(buildPhase(live())).toEqual({ kind: "live", sync: { kind: "in-sync" } });
	});

	it("reads as building while a rebuild or the first build runs", () => {
		for (let state of ["queued", "starting", "running"] as const) {
			expect(syncStatus(live({ outOfSync: true, rebuild: rebuild(state) })))
				.toEqual({ kind: "building" });
		}
		expect(syncStatus({ ...live(), build: build("running") })).toEqual({ kind: "building" });
	});

	it("explains a first build queued behind another document's build", () => {
		let queued = snapshot({ build: build("queued"), waitingForDocument: { title: "Docs site" } });
		expect(startingHint(queued)).toBe("Starts when your agent finishes “Docs site”");
		expect(startingHint(snapshot({ build: build("queued"), waitingForDocument: {} })))
			.toBe("Starts when your agent finishes another document");
	});

	it("explains a first build queued behind a prototype", () => {
		let queued = snapshot({ build: build("queued"), waitingForPrototype: true });
		expect(firstBuildStep(queued, { stage: "idle" }).view).toBe("working");
		expect(startingHint(queued)).toBe("Starts when the current prototype finishes");
		expect(startingHint(snapshot({ build: build("queued") }))).toBeUndefined();
		expect(startingHint(snapshot({ build: build("running"), waitingForPrototype: true })))
			.toBeUndefined();
	});

	it("explains why it is out of sync", () => {
		let pending = live({ outOfSync: true, rebuild: rebuild("stopped") });
		expect(syncStatus(pending)).toEqual({ kind: "out-of-sync", reason: "pending", outstanding: 0 });
		expect(syncHint(syncStatus(pending), pending, "me")).toBe("Changes will build shortly");
		let waiting = { ...live({ outOfSync: true, builderConnected: false }), builtBy: "jev" };
		expect(syncStatus(waiting)).toEqual({ kind: "out-of-sync", reason: "waiting", outstanding: 0 });
		expect(syncHint(syncStatus(waiting), waiting, "me")).toBe("Waiting for @jev’s agent");
		expect(syncHint(syncStatus(waiting), waiting, "u")).toBe("Waiting for your agent");
		let failed = live({ outOfSync: true, rebuild: rebuild("failed") });
		expect(syncStatus(failed)).toEqual({ kind: "out-of-sync", reason: "failed", outstanding: 0 });
		expect(syncHint(syncStatus(failed), failed, "me")).toBe("The last rebuild failed");
	});

	it("needs attention while a blocked task waits for an edit, even in sync", () => {
		let outstandingTasks = [
			{ id: "a", title: "Store graphs", state: "blocked" as const, blocker: "Which database?" },
			{ id: "b", title: "Render graphs", state: "queued" as const },
		];
		let stuck = live({ outstandingTasks });
		expect(syncStatus(stuck)).toEqual({ kind: "needs-attention", outstanding: 2 });
		expect(syncHint(syncStatus(stuck), stuck, "me"))
			.toBe(
				"“Store graphs” is blocked: Which database? (and 1 other). Edit the document to retry.",
			);
		let edited = live({ outstandingTasks, outOfSync: true });
		expect(syncStatus(edited)).toEqual({ kind: "out-of-sync", reason: "pending", outstanding: 2 });
		expect(syncHint(syncStatus(edited), edited, "me"))
			.toBe("Changes will build shortly · will also retry 2 blocked tasks");
		// Syncing beats needing attention.
		expect(syncStatus(live({ outstandingTasks, rebuild: rebuild("running") })))
			.toEqual({ kind: "building" });
	});

	it("ends a blocker's hint with one stop, whatever punctuation it brought", () => {
		let hint = (blocker: string) =>
			attentionHint(live({
				outstandingTasks: [{ id: "a", title: "Ship", state: "blocked", blocker }],
			}));
		expect(hint("I can't decide this myself.")).toBe(
			"“Ship” is blocked: I can't decide this myself. Edit the document to retry.",
		);
		expect(hint("Which database?")).toBe(
			"“Ship” is blocked: Which database? Edit the document to retry.",
		);
	});

	it("needs attention when a first build stopped on a blocker before any pull request", () => {
		let stopped = live({
			pullRequests: [],
			outstandingTasks: [{ id: "a", title: "Ship", state: "blocked", blocker: "Pick a host" }],
		});
		expect(buildPhase(stopped)).toEqual({
			kind: "live",
			sync: { kind: "needs-attention", outstanding: 1 },
		});
		expect(attentionHint(stopped)).toBe(
			"“Ship” is blocked: Pick a host. Edit the document to retry.",
		);
	});

	it("does not call a failed rebuild out of sync once later edits match", () => {
		expect(syncStatus(live({ rebuild: rebuild("failed") }))).toEqual({ kind: "in-sync" });
		expect(syncHint({ kind: "in-sync" }, live(), "me")).toBeUndefined();
	});
});

describe("living document commits", () => {
	let commit = (sha: string, at: string, pullRequest = PR) => ({
		pullRequest,
		sha,
		message: sha,
		revision: 5,
		at,
	});

	it("groups one pull request's commits, newest first", () => {
		let value = live({
			commits: [
				commit("a", "2026-10-10T10:00:00.000Z"),
				commit("b", "2026-10-10T11:00:00.000Z", "https://github.com/o/r/pull/8"),
				commit("c", "2026-10-10T12:00:00.000Z"),
				commit("d", "2026-10-10T12:00:00.000Z"),
			],
		});
		expect(pullRequestCommits(value, PR).map(item => item.sha)).toEqual(["d", "c", "a"]);
		expect(pullRequestCommits(snapshot(), PR)).toEqual([]);
	});

	it("says how long ago a commit landed", () => {
		let now = Date.parse("2026-10-10T12:00:00.000Z");
		expect(ago("2026-10-10T11:59:40.000Z", now)).toBe("just now");
		expect(ago("2026-10-10T11:55:00.000Z", now)).toBe("5m ago");
		expect(ago("2026-10-10T09:00:00.000Z", now)).toBe("3h ago");
		expect(ago("2026-10-08T12:00:00.000Z", now)).toBe("2d ago");
		expect(ago("nonsense", now)).toBeUndefined();
	});
});

describe("build status", () => {
	let context = {
		state: { stage: "idle" } as const,
		userId: "u",
		live: false,
		canEdit: true,
		connected: true,
		planner: true,
		hasContent: true,
		unanswered: 0,
	};
	let look = (value: ImplementationSnapshot | undefined, change = {}) =>
		buildLook(value, { ...context, ...change });

	it("offers Build plan before the first build, inert with its reason", () => {
		expect(look(snapshot())).toEqual({ kind: "plan", blocked: undefined });
		expect(look(snapshot(), { hasContent: false })).toEqual({
			kind: "plan",
			blocked: "Write the document first",
		});
		expect(look(snapshot({ blockers: ["unanswered questionnaires"] }), { unanswered: 2 }))
			.toEqual({ kind: "plan", blocked: "Answer 2 open decisions first" });
		expect(look(snapshot({ blockers: ["accepted comments awaiting plan changes"] })).kind)
			.toBe("plan");
		expect(look(snapshot({ buildReady: false }))).toEqual({
			kind: "plan",
			blocked: "Add more detail before building",
		});
		expect(look(snapshot({ graph: undefined }), { planner: false })).toEqual({
			kind: "plan",
			blocked: "Chopin isn’t running for this document",
		});
		expect(look(undefined)).toEqual({ kind: "plan", blocked: "Chopin isn’t connected" });
	});

	it("breaks into tasks once pressed, then counts tasks with pull requests", () => {
		let pressed = { stage: "drafting", sent: true } as const;
		expect(look(snapshot({ graph: undefined }), { state: pressed }).kind).toBe("tasks");
		let running = snapshot({
			build: build("running"),
			lifecycle: {
				execution: { state: "active" } as ImplementationSnapshot["lifecycle"]["execution"],
				history: [],
				activity: {
					tasks: [
						{ id: "a", state: "completed", pullRequest: { url: PR, state: "open" } },
						{ id: "b", state: "in_progress" },
						{ id: "c", state: "queued" },
					],
					events: [],
				} as unknown as ImplementationSnapshot["lifecycle"]["activity"],
			},
		});
		let building = look(running);
		expect(building).toMatchObject({ kind: "building", done: 1, total: 3 });
		expect(buildLabel(building)).toBe("Building · 1 of 3");
	});

	it("reads a delivered build as built, and a stopped first build as stopped with Retry", () => {
		let done = snapshot({
			build: build("stopped"),
			lifecycle: { execution: { state: "idle" }, history: [run({ kind: "implemented" }, 2)] },
		});
		expect(look(done)).toMatchObject({ kind: "built", pullRequests: 2 });
		let failed = look(snapshot({ build: build("failed") }));
		expect(failed).toMatchObject({ kind: "stopped", retry: true });
		expect(buildLabel(failed)).toBe("Build stopped");
		expect(look(snapshot({ build: build("failed") }), { canEdit: false }))
			.toMatchObject({ retry: false });
		let noAgent = look(snapshot(), { state: { stage: "failed", agent: true } });
		expect(noAgent).toEqual({
			kind: "stopped",
			tip: "Start your local agent, then retry",
			retry: true,
		});
	});

	it("counts changes to build since the last build, and waits for edits to settle when live", () => {
		let stale = live({ outOfSync: true, changes: 3, rebuild: rebuild("stopped") });
		let manual = look(stale);
		expect(manual).toMatchObject({ kind: "stale", changes: 3, live: false });
		expect(buildLabel(manual)).toBe("3 changes to build");
		expect(manual).toMatchObject({ tip: "Edits since the last build" });
		expect(buildLabel(look(live({ outOfSync: true, changes: 1 })))).toBe("1 change to build");
		expect(look(stale, { live: true })).toMatchObject({
			kind: "stale",
			live: true,
			tip: "Builds when editing settles",
		});
		let theirs = { ...stale, builtBy: "maggie" };
		expect(look(theirs, { userId: "other", live: true }))
			.toMatchObject({ tip: "Builds on @maggie’s agent when editing settles" });
		expect(look(theirs, { userId: "other" })).toMatchObject({
			tip: "Edits since @maggie built it",
		});
	});

	it("reads a rebuild as building changes, and a failed one as failed", () => {
		let running = look(live({ outOfSync: true, rebuild: rebuild("running") }));
		expect(buildLabel(running)).toBe("Building changes…");
		let failed = look(live({ outOfSync: true, rebuild: rebuild("failed") }));
		expect(buildLabel(failed)).toBe("Build failed");
		expect(buildLabel(look(live()))).toBe("Built");
		expect(look({ ...live(), builtBy: "maggie" }, { userId: "other" }))
			.toMatchObject({ tip: "Every pull request matches the document · built by @maggie" });
	});

	it("opens Build only once there is a build or a press under way", () => {
		expect(buildTabReady(snapshot(), look(snapshot()))).toBe(false);
		let pressed = { stage: "drafting", sent: false } as const;
		expect(buildTabReady(snapshot(), look(snapshot(), { state: pressed }))).toBe(true);
		let returned = snapshot({
			build: build("stopped"),
			lifecycle: {
				execution: { state: "idle" },
				history: [run({ kind: "revision_requested", reason: "Change it" })],
			},
		});
		expect(look(returned).kind).toBe("plan");
		expect(buildTabReady(returned, look(returned))).toBe(true);
	});
});
