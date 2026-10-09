import { describe, expect, it } from "bun:test";

import {
	awaitingRetry,
	emptyResyncQueue,
	MAX_WATCH_FRAME_REPOSITORIES,
	MAX_WATCHED_DOCUMENTS,
	MAX_WATCHED_REPOSITORIES,
	planDecisionWatch,
	requestResync,
	RESYNC_INTERVAL_MS,
	retryDecisionWatch,
	retryDelay,
	settleDecisionWatch,
	takeResyncs,
} from "./sidebar-decision-watch";

import type { Sidebar } from "@chopin/protocol";
import type { WatchLedger } from "./sidebar-decision-watch";

function repository(name: string, channelIds: string[] = []): Sidebar.WatchedRepository {
	return { repositoryId: `R_${name}`, owner: "octo-org", name, channelIds };
}

function watched(
	ids: string[],
	refused: string[] = [],
	unavailable: string[] = [],
): Sidebar.Watched {
	return { kind: "sidebar:watched", ts: 0, watched: ids, refused, unavailable };
}

function documents(count: number, prefix = "channel"): string[] {
	return Array.from({ length: count }, (_, index) => `${prefix}-${index}`);
}

function settleAll(
	plan: ReturnType<typeof planDecisionWatch>,
	reply: (frame: Sidebar.WatchedRepository[]) => Sidebar.Watched | undefined,
): WatchLedger {
	let ledger = plan.ledger;
	for (let frame of plan.frames) {
		ledger = settleDecisionWatch(ledger, frame, reply(frame.repositories));
	}
	return ledger;
}

function allWatched(frame: Sidebar.WatchedRepository[]) {
	return watched(frame.map(item => item.repositoryId));
}

describe("sidebar decision watch plans", () => {
	it("watches every repository with every loaded document on a fresh connection", () => {
		let plan = planDecisionWatch(new Map(), [
			repository("score", ["a", "b"]),
			repository("archive"),
		]);
		expect(plan.unwatch).toEqual([]);
		expect(plan.frames.map(frame => frame.repositories)).toEqual([[
			repository("score", ["a", "b"]),
			repository("archive"),
		]]);
		expect(plan.ledger.get("R_score")?.status).toBe("requested");
	});

	it("splits large sidebars into bounded frames that list each repository once", () => {
		let repositories = Array.from(
			{ length: MAX_WATCHED_REPOSITORIES },
			(_, index) => repository(`archive-${index}`),
		);
		repositories[0] = repository("archive-0", documents(MAX_WATCHED_DOCUMENTS * 2 + 1));
		let plan = planDecisionWatch(new Map(), repositories);
		for (let frame of plan.frames) {
			expect(frame.repositories.length).toBeLessThanOrEqual(MAX_WATCH_FRAME_REPOSITORIES);
			let ids = frame.repositories.map(item => item.repositoryId);
			expect(new Set(ids).size).toBe(ids.length);
			for (let item of frame.repositories) {
				expect(item.channelIds.length).toBeLessThanOrEqual(MAX_WATCHED_DOCUMENTS);
			}
		}
		let sent = plan.frames.flatMap(frame => frame.repositories);
		expect(new Set(sent.map(item => item.repositoryId)).size).toBe(MAX_WATCHED_REPOSITORIES);
		expect(
			sent.filter(item => item.repositoryId === "R_archive-0").flatMap(item => item.channelIds),
		).toEqual(documents(MAX_WATCHED_DOCUMENTS * 2 + 1));
	});

	it("sends nothing while the sidebar is unchanged", () => {
		let first = planDecisionWatch(new Map(), [repository("score", ["a"])]);
		let ledger = settleAll(first, allWatched);
		let again = planDecisionWatch(ledger, [repository("score", ["a"])]);
		expect(again.frames).toEqual([]);
		expect(again.unwatch).toEqual([]);
	});

	it("reconciles documents that load after the repository was first watched", () => {
		let first = planDecisionWatch(new Map(), [repository("score")]);
		let ledger = settleAll(first, allWatched);
		let loaded = planDecisionWatch(ledger, [repository("score", ["a", "b"])]);
		expect(loaded.frames.map(frame => frame.repositories)).toEqual([[
			repository("score", ["a", "b"]),
		]]);
		let more = planDecisionWatch(settleAll(loaded, allWatched), [
			repository("score", ["a", "b", "c"]),
		]);
		expect(more.frames.map(frame => frame.repositories)).toEqual([[repository("score", ["c"])]]);
	});

	it("unwatches repositories the sidebar no longer shows", () => {
		let first = planDecisionWatch(new Map(), [repository("score"), repository("archive")]);
		let next = planDecisionWatch(settleAll(first, allWatched), [repository("score")]);
		expect(next.unwatch).toEqual([["R_archive"]]);
		expect(next.frames).toEqual([]);
		expect([...next.ledger.keys()]).toEqual(["R_score"]);
	});

	it("watches a renamed repository again with every loaded document", () => {
		let first = planDecisionWatch(new Map(), [repository("score", ["a"])]);
		let renamed = { ...repository("score", ["a"]), name: "score-renamed" };
		let next = planDecisionWatch(settleAll(first, allWatched), [renamed]);
		expect(next.frames.map(frame => frame.repositories)).toEqual([[renamed]]);
	});

	it("leaves refused repositories alone until their name changes or the socket reconnects", () => {
		let first = planDecisionWatch(new Map(), [repository("secret", ["a"])]);
		let ledger = settleAll(first, () => watched([], ["R_secret"]));
		expect(ledger.get("R_secret")?.status).toBe("refused");
		expect(awaitingRetry(ledger)).toBe(false);
		expect(planDecisionWatch(ledger, [repository("secret", ["a", "b"])]).frames).toEqual([]);
		expect(planDecisionWatch(new Map(), [repository("secret", ["a"])]).frames).toHaveLength(1);
	});

	it("retries repositories GitHub could not check, with every document loaded meanwhile", () => {
		let first = planDecisionWatch(new Map(), [repository("score"), repository("other", ["a"])]);
		let ledger = settleAll(first, () => watched(["R_score"], [], ["R_other"]));
		expect(awaitingRetry(ledger)).toBe(true);
		expect(planDecisionWatch(ledger, [repository("score"), repository("other", ["a", "b"])]).frames)
			.toEqual([]);
		let retried = planDecisionWatch(retryDecisionWatch(ledger), [
			repository("score"),
			repository("other", ["a", "b"]),
		]);
		expect(retried.frames.map(frame => frame.repositories)).toEqual([[
			repository("other", ["a", "b"]),
		]]);
		let recovered = settleAll(retried, allWatched);
		expect(recovered.get("R_other")?.status).toBe("watched");
		expect(awaitingRetry(recovered)).toBe(false);
	});

	it("retries every repository of a request that failed outright", () => {
		let first = planDecisionWatch(new Map(), [repository("score"), repository("archive")]);
		let ledger = settleAll(first, () => undefined);
		expect([...ledger.values()].map(entry => entry.status)).toEqual([
			"unavailable",
			"unavailable",
		]);
	});

	it("lets a later plan's reply decide, but keeps the documents of a failed earlier frame", () => {
		let first = planDecisionWatch(new Map(), [repository("score", ["a"])]);
		let second = planDecisionWatch(first.ledger, [repository("score", ["a", "b"])]);
		expect(second.frames.map(frame => frame.repositories)).toEqual([[
			repository("score", ["b"]),
		]]);
		let ledger = settleDecisionWatch(second.ledger, second.frames[0]!, watched(["R_score"]));
		expect(settleDecisionWatch(ledger, first.frames[0]!, watched(["R_score"])).get("R_score"))
			.toBe(ledger.get("R_score"));
		let failed = settleDecisionWatch(ledger, first.frames[0]!, undefined);
		expect(failed.get("R_score")?.status).toBe("unavailable");
		let retried = planDecisionWatch(retryDecisionWatch(failed), [repository("score", ["a", "b"])]);
		expect(retried.frames.map(frame => frame.repositories)).toEqual([[
			repository("score", ["a", "b"]),
		]]);
	});

	it("backs off retries up to a minute", () => {
		expect([0, 1, 2, 3, 4, 5, 10].map(retryDelay)).toEqual([
			2_000,
			4_000,
			8_000,
			16_000,
			32_000,
			60_000,
			60_000,
		]);
	});
});

describe("sidebar decision resynchronization", () => {
	let desired = [repository("score", ["a", "b"]), repository("other"), repository("denied")];
	let plan = planDecisionWatch(new Map(), desired);
	let ledger = settleAll(plan, () => watched(["R_score", "R_other"], ["R_denied"]));

	it("re-watches a conflicting repository with no documents to get a fresh snapshot", () => {
		let queue = requestResync(emptyResyncQueue(), "R_score");
		let taken = takeResyncs(queue, ledger, desired, 10_000);

		expect(taken.frames).toEqual([[repository("score")]]);
		expect(taken.wait).toBeUndefined();
		expect(taken.queue.pending.size).toBe(0);
	});

	it("coalesces a burst of conflicts into one snapshot per repository each second", () => {
		let queue = requestResync(requestResync(emptyResyncQueue(), "R_score"), "R_score");
		let first = takeResyncs(queue, ledger, desired, 10_000);
		expect(first.frames).toEqual([[repository("score")]]);

		let burst = requestResync(requestResync(first.queue, "R_score"), "R_other");
		let second = takeResyncs(burst, ledger, desired, 10_400);
		expect(second.frames).toEqual([[repository("other")]]);
		expect(second.wait).toBe(RESYNC_INTERVAL_MS - 400);
		expect(takeResyncs(second.queue, ledger, desired, 10_900).frames).toEqual([]);

		let due = takeResyncs(second.queue, ledger, desired, 10_000 + RESYNC_INTERVAL_MS);
		expect(due.frames).toEqual([[repository("score")]]);
		expect(due.queue.pending.size).toBe(0);
	});

	it("drops repositories this connection does not watch, since no snapshot would answer", () => {
		let queue = ["R_denied", "R_missing", "R_score"].reduce(requestResync, emptyResyncQueue());
		let renamed = [{ ...repository("score"), name: "renamed" }, ...desired.slice(1)];

		let taken = takeResyncs(queue, ledger, renamed, 10_000);
		expect(taken.frames).toEqual([]);
		expect(taken.queue.pending.size).toBe(0);
		let requested = planDecisionWatch(new Map(), [repository("score")]).ledger;
		expect(takeResyncs(queue, requested, desired, 10_000).frames).toEqual([
			[repository("score")],
		]);
	});
});
