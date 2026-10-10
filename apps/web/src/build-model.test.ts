import { describe, expect, it } from "bun:test";

import {
	advanceDraft,
	advanceFirstBuild,
	ago,
	attentionHint,
	blockerLabelled,
	blockerText,
	buildPhase,
	draftKey,
	draftRefusalCopy,
	elapsed,
	firstBuildStep,
	linkParts,
	liveTaskGroups,
	liveTaskState,
	pullRequestCommits,
	pullRequestNumber,
	shortUrl,
	shouldAutoDraft,
	startedBy,
	startingHint,
	startingLabel,
	syncHint,
	syncLabel,
	syncStatus,
	syncTooltip,
	taskStartsOpen,
	unfinishedReason,
	waitingLabel,
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

describe("drafting", () => {
	it("keys one automatic request per document, revision and reason", () => {
		expect(draftKey("room", 4, "prepare")).toBe("room:4:prepare");
		expect(draftKey("room", 4, "revise")).not.toBe(draftKey("room", 5, "revise"));
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

describe("automatic drafting", () => {
	let ready = {
		active: true,
		canDraft: true,
		chatLoaded: true,
		plannerBusy: false,
		connected: true,
		key: "room:4:prepare",
		eligible: "room:4:prepare",
		autoSent: false,
		alreadyDrafted: false,
		request: undefined,
	};

	it("drafts once for the need the first read of this visit saw", () => {
		expect(shouldAutoDraft(ready)).toBe(true);
		expect(shouldAutoDraft({ ...ready, autoSent: true })).toBe(false);
		expect(shouldAutoDraft({ ...ready, alreadyDrafted: true })).toBe(false);
		// A collaborator's edit while Build stays open changes the need, not the decision.
		expect(shouldAutoDraft({ ...ready, key: "room:5:revise" })).toBe(false);
		expect(shouldAutoDraft({ ...ready, eligible: undefined })).toBe(false);
	});

	it("waits for Chat, the socket and an idle Planner, and for any request in flight", () => {
		expect(shouldAutoDraft({ ...ready, chatLoaded: false })).toBe(false);
		expect(shouldAutoDraft({ ...ready, connected: false })).toBe(false);
		expect(shouldAutoDraft({ ...ready, plannerBusy: true })).toBe(false);
		expect(shouldAutoDraft({ ...ready, request: { key: "room:4:prepare", state: "queued" } }))
			.toBe(false);
		expect(shouldAutoDraft({ ...ready, request: { key: "room:4:prepare", state: "failed" } }))
			.toBe(true);
	});

	it("follows only its own request from answer to end", () => {
		let sending = { key: "k", state: "sending" as const };
		let queued = advanceDraft(sending, { type: "reply", id: "d1", state: "queued" })!;
		expect(queued).toEqual({ key: "k", id: "d1", state: "queued" });
		// Another request's turn says nothing about this one.
		expect(advanceDraft(queued, { type: "drafting", id: "d2", state: "ended" })).toBeUndefined();
		let running = advanceDraft(queued, { type: "drafting", id: "d1", state: "running" })!;
		expect(running.state).toBe("running");
		expect(advanceDraft(running, { type: "drafting", id: "d1", state: "ended" })?.state)
			.toBe("ended");
		expect(advanceDraft(undefined, { type: "busy", busy: false })).toBeUndefined();
	});

	it("ends an acknowledged running request on an idle Planner, busy or not", () => {
		let running = { key: "k", id: "d1", state: "running" as const };
		expect(advanceDraft(running, { type: "busy", busy: false })?.state).toBe("ended");
		// Not before the server has answered: the request might not have started.
		expect(advanceDraft({ key: "k", state: "sending" }, { type: "busy", busy: false }))
			.toBeUndefined();
		let sending = { key: "k", state: "sending" as const };
		expect(advanceDraft(sending, { type: "reply", id: "d1", state: "ended" })?.state)
			.toBe("ended");
	});

	it("fails a refused request, and ends a queued one on an idle Planner after seeing it busy", () => {
		let sending = { key: "k", state: "sending" as const };
		expect(advanceDraft(sending, { type: "refused" })?.state).toBe("failed");
		let queued = { key: "k", id: "d1", state: "queued" as const };
		expect(advanceDraft(queued, { type: "busy", busy: false })).toBeUndefined();
		let seen = advanceDraft(queued, { type: "busy", busy: true })!;
		expect(seen.busySeen).toBe(true);
		expect(advanceDraft(seen, { type: "busy", busy: false })?.state).toBe("ended");
		// A late answer cannot move a request that has already finished.
		expect(advanceDraft({ ...seen, state: "ended" }, { type: "reply", id: "d1", state: "queued" }))
			.toBeUndefined();
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

	it("offers the button only for a ready document that was never built", () => {
		expect(firstBuildStep(fresh, idle)).toEqual({ view: "ready" });
		expect(firstBuildStep(snapshot(), idle)).toEqual({ view: "ready" });
		expect(firstBuildStep(undefined, idle)).toEqual({ view: "hidden" });
		expect(firstBuildStep(snapshot({ graph: undefined, buildReady: false }), idle).view)
			.toBe("hidden");
		expect(firstBuildStep(snapshot({ blockers: ["unanswered questionnaires"] }), idle).view)
			.toBe("hidden");
		expect(firstBuildStep(snapshot({ build: build("failed") }), idle).view).toBe("hidden");
		expect(firstBuildStep(snapshot({ build: build("running") }), idle).view).toBe("working");
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
		expect(firstBuildStep(fresh, failed)).toEqual({ view: "ready" });
		expect(advanceFirstBuild(failed, { type: "press" })).toEqual({
			stage: "drafting",
			sent: false,
		});

		let starting = advanceFirstBuild(sent, { type: "start" });
		let noAgent = advanceFirstBuild(starting, { type: "start-refused", agent: true });
		expect(noAgent).toEqual({ stage: "failed", agent: true, message: undefined });
		expect(firstBuildStep(snapshot(), noAgent)).toEqual({ view: "ready" });
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
		expect(waitingLabel(blocked)).toEqual({ label: "Waiting on a decision", target: "decisions" });
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
		expect(firstBuildStep(blocked, idle, "you").view).toBe("hidden");
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
			.toEqual({ view: "hidden", next: "reset" });
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
		expect(startingLabel(queued)).toEqual({
			label: "Queued",
			queued: true,
			hint: "Starts when your agent finishes “Docs site”",
		});
		expect(startingHint(snapshot({ build: build("queued"), waitingForDocument: {} })))
			.toBe("Starts when your agent finishes another document");
	});

	it("explains a first build queued behind a prototype", () => {
		let queued = snapshot({ build: build("queued"), waitingForPrototype: true });
		expect(firstBuildStep(queued, { stage: "idle" }).view).toBe("working");
		expect(startingHint(queued)).toBe("Starts when the current prototype finishes");
		expect(startingLabel(queued)).toEqual({
			label: "Queued",
			queued: true,
			hint: "Starts when the current prototype finishes",
		});
		expect(startingLabel(snapshot({ build: build("queued") })))
			.toEqual({ label: "Building…", queued: false });
		expect(startingLabel(undefined)).toEqual({ label: "Building…", queued: false });
		expect(startingHint(snapshot({ build: build("queued") }))).toBeUndefined();
		expect(startingHint(snapshot({ build: build("running"), waitingForPrototype: true })))
			.toBeUndefined();
	});

	it("explains why it is out of sync", () => {
		let pending = live({ outOfSync: true, rebuild: rebuild("stopped") });
		expect(syncStatus(pending)).toEqual({ kind: "out-of-sync", reason: "pending", outstanding: 0 });
		expect(syncHint(syncStatus(pending), pending, "me")).toBe("Your edits will sync shortly");
		let waiting = { ...live({ outOfSync: true, builderConnected: false }), builtBy: "jev" };
		expect(syncStatus(waiting)).toEqual({ kind: "out-of-sync", reason: "waiting", outstanding: 0 });
		expect(syncHint(syncStatus(waiting), waiting, "me")).toBe("Waiting for @jev’s agent");
		expect(syncHint(syncStatus(waiting), waiting, "u")).toBe("Waiting for your agent");
		let failed = live({ outOfSync: true, rebuild: rebuild("failed") });
		expect(syncStatus(failed)).toEqual({ kind: "out-of-sync", reason: "failed", outstanding: 0 });
		expect(syncHint(syncStatus(failed), failed, "me")).toBe("The next edit will try again");
		expect(syncLabel({ kind: "out-of-sync", reason: "failed", outstanding: 0 })).toBe(
			"Sync failed",
		);
		expect(syncLabel({ kind: "out-of-sync", reason: "waiting", outstanding: 0 }))
			.toBe("Out of sync");
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
				"“Store graphs” is blocked: Which database? (and 1 other). Edit the document to retry them.",
			);
		let edited = live({ outstandingTasks, outOfSync: true });
		expect(syncStatus(edited)).toEqual({ kind: "out-of-sync", reason: "pending", outstanding: 2 });
		expect(syncHint(syncStatus(edited), edited, "me"))
			.toBe("Your edits and 2 blocked tasks will sync shortly");
		let waiting = { ...live({ outstandingTasks, outOfSync: true, builderConnected: false }) };
		expect(syncHint(syncStatus(waiting), waiting, "u"))
			.toBe("Waiting for your agent to sync your edits and 2 blocked tasks");
		let failed = live({ outstandingTasks, outOfSync: true, rebuild: rebuild("failed") });
		expect(syncHint(syncStatus(failed), failed, "me"))
			.toBe("The next edit will retry the sync and 2 blocked tasks");
		expect(syncLabel(syncStatus(stuck)!)).toBe("Needs attention");
		expect(syncTooltip(syncStatus(stuck)!, stuck, "me")).toContain(
			"Edit the document to retry them.",
		);
		// Syncing beats needing attention.
		expect(syncStatus(live({ outstandingTasks, rebuild: rebuild("running") })))
			.toEqual({ kind: "building" });
	});

	it("leaves the blocker to the task row in the Build view's brief hint", () => {
		let stuck = live({
			outstandingTasks: [
				{ id: "a", title: "Store graphs", state: "blocked", blocker: "Which database?" },
				{ id: "b", title: "Render graphs", state: "queued" },
			],
		});
		expect(attentionHint(stuck, true))
			.toBe("Edit the document to retry “Store graphs” and 1 other");
		let unfinished = live({ outstandingTasks: [{ id: "a", title: "Ship", state: "queued" }] });
		expect(attentionHint(unfinished, true)).toBe("Edit the document to retry “Ship”");
	});

	it("caps a long blocker in the tooltip at a word boundary", () => {
		let blocker = `The repository has no app.${" Should I scaffold one?".repeat(10)}`;
		let hint = attentionHint(live({
			outstandingTasks: [{ id: "a", title: "Ship", state: "blocked", blocker }],
		}))!;
		expect(hint).toMatch(/^“Ship” is blocked: The repository has no app\. Should I .*…/);
		expect(hint.endsWith("… Edit the document to retry it.")).toBe(true);
		expect(hint.length).toBeLessThan(180);
	});

	it("says why an unfinished task stopped: its last report, else where the agent stopped", () => {
		expect(unfinishedReason(undefined)).toBe("Your agent stopped before opening a pull request");
		expect(unfinishedReason({ pullRequest: { url: PR, state: "open" } }))
			.toBe("Your agent stopped before finishing this task");
		expect(unfinishedReason({ summary: "  Tests still fail on CI. " }))
			.toBe("Tests still fail on CI.");
		let task = (progress: object) => ({
			id: "a",
			title: "Ship",
			context: "",
			goal: "",
			acceptance: [],
			dependsOn: [],
			progress: { id: "a", state: "queued" as const, ...progress },
		});
		let quiet = live({
			outstandingTasks: [{ id: "a", title: "Ship", state: "queued" }],
			tasks: [task({})],
		});
		expect(attentionHint(quiet)).toBe(
			"“Ship” didn’t finish: your agent stopped before opening a pull request. Edit the document to retry it.",
		);
		let reported = live({
			outstandingTasks: [{ id: "a", title: "Ship", state: "queued" }],
			tasks: [task({ summary: "Waiting on a review of https://github.com/o/r/pull/7." })],
		});
		expect(attentionHint(reported)).toBe(
			"“Ship” didn’t finish: Waiting on a review of o/r#7. Edit the document to retry it.",
		);
	});

	it("drops an agent's stacked Blocked: labels and keeps its own", () => {
		expect(blockerText("Blocked: Blocker - Which database?")).toBe("Which database?");
		expect(blockerText("Blocked by CI")).toBe("Blocked by CI");
		expect(blockerLabelled("Awaiting human confirmation: Jev must confirm")).toBe(true);
		expect(blockerLabelled("Which database? Postgres: or SQLite")).toBe(false);
		expect(blockerLabelled("https://github.com/o/r/pull/1 fails")).toBe(false);
		let hint = attentionHint(live({
			outstandingTasks: [{
				id: "a",
				title: "Ship",
				state: "blocked",
				blocker: "Blocked: Awaiting review: see https://github.com/o/r/pull/28#issuecomment-339.",
			}],
		}));
		expect(hint).toBe(
			"“Ship” is blocked: Awaiting review: see o/r#28 comment. Edit the document to retry it.",
		);
	});

	it("shortens GitHub links and leaves other links whole", () => {
		expect(shortUrl("https://github.com/o/r/pull/28")).toBe("o/r#28");
		expect(shortUrl("https://github.com/o/r/issues/3#issuecomment-12")).toBe("o/r#3 comment");
		expect(shortUrl("https://github.com/o/r/pull/28/files")).toBe("o/r#28");
		expect(shortUrl("https://example.com/o/r/pull/28")).toBeUndefined();
		expect(
			linkParts("on PR #28 (https://github.com/o/r/pull/28#issuecomment-9). See https://x.dev/a."),
		).toEqual([
			{ text: "on PR #28 (" },
			{ text: "o/r#28 comment", href: "https://github.com/o/r/pull/28#issuecomment-9" },
			{ text: "). See " },
			{ text: "https://x.dev/a", href: "https://x.dev/a" },
			{ text: "." },
		]);
		expect(linkParts("no links")).toEqual([{ text: "no links" }]);
	});

	it("shows a task the first build left unfinished as needing attention until a sync runs", () => {
		expect(liveTaskState("queued", true, false)).toBe("blocked");
		expect(liveTaskState("queued", true, true)).toBe("queued");
		expect(liveTaskState("queued", false, false)).toBe("queued");
		expect(liveTaskState("in_progress", true, false)).toBe("in_progress");
		expect(liveTaskState("completed", true, false)).toBe("completed");
	});

	it("ends a blocker's hint with one stop, whatever punctuation it brought", () => {
		let hint = (blocker: string) =>
			attentionHint(live({
				outstandingTasks: [{ id: "a", title: "Ship", state: "blocked", blocker }],
			}));
		expect(hint("I can't decide this myself.")).toBe(
			"“Ship” is blocked: I can't decide this myself. Edit the document to retry it.",
		);
		expect(hint("Which database?")).toBe(
			"“Ship” is blocked: Which database? Edit the document to retry it.",
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
			"“Ship” is blocked: Pick a host. Edit the document to retry it.",
		);
	});

	it("does not call a failed rebuild out of sync once later edits match", () => {
		expect(syncStatus(live({ rebuild: rebuild("failed") }))).toEqual({ kind: "in-sync" });
		expect(syncHint({ kind: "in-sync" }, live(), "me")).toBeUndefined();
	});

	it("names every state with one sync vocabulary and a tooltip", () => {
		expect(syncLabel({ kind: "in-sync" })).toBe("In sync");
		expect(syncLabel({ kind: "building" })).toBe("Syncing…");
		expect(syncTooltip({ kind: "in-sync" }, live(), "me")).toBe("Pull requests match the document");
		expect(syncTooltip({ kind: "building" }, live(), "me"))
			.toBe("Updating pull requests to match the document");
		let pending = live({ outOfSync: true, rebuild: rebuild("stopped") });
		expect(syncTooltip(syncStatus(pending)!, pending, "me")).toBe("Your edits will sync shortly");
	});

	it("splits the first build's tasks from those later syncs added", () => {
		let tasks = [{ id: "workspace" }, { id: "rebuild-2-1" }, { id: "notes" }, {
			id: "rebuild-3-1",
		}];
		expect(liveTaskGroups(tasks)).toEqual({
			first: [{ id: "workspace" }, { id: "notes" }],
			since: [{ id: "rebuild-2-1" }, { id: "rebuild-3-1" }],
		});
		expect(liveTaskGroups([{ id: "workspace" }]).since).toEqual([]);
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
