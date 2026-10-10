import { describe, expect, it } from "bun:test";

import {
	advanceDraft,
	buildPhase,
	draftKey,
	draftRefusalCopy,
	elapsed,
	pullRequestNumber,
	shouldAutoDraft,
	startedBy,
	taskStartsOpen,
} from "./build-model";

import type { BuildRequest, ImplementationSnapshot } from "@chopin/protocol/implementation";

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
