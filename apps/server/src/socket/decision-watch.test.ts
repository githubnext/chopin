import { describe, expect, it } from "bun:test";

import { GitHubError } from "../github/client";

import {
	decisionWatch,
	MAX_WATCH_FRAME_REPOSITORIES,
	MAX_WATCHED_DOCUMENTS,
	MAX_WATCHED_REPOSITORIES,
	recheckDecisionWatch,
	releaseDecisionWatch,
	repositoryReader,
	unwatchDecisions,
	unwatchRequest,
	watchDecisions,
	watchRequest,
} from "./decision-watch";

import type { AuthorizationResult } from "../wire";
import type { RepositoryIdentity, WatchedRepository } from "./decision-watch";

const DOCUMENT = "cccccccc-0000-4000-8000-000000000001";

function repository(name: string, channelIds: string[] = []): WatchedRepository {
	return { repositoryId: `R_${name}`, owner: "octo-org", name, channelIds };
}

function topics() {
	let subscribed = new Set<string>();
	let log: string[] = [];
	return {
		subscribed,
		log,
		subscribe(repositoryId: string) {
			subscribed.add(repositoryId);
			log.push(`+${repositoryId}`);
		},
		unsubscribe(repositoryId: string) {
			subscribed.delete(repositoryId);
			log.push(`-${repositoryId}`);
		},
	};
}

function access(results: Record<string, AuthorizationResult>) {
	let asked: string[] = [];
	return {
		asked,
		authorize: (target: RepositoryIdentity) => {
			asked.push(`${target.owner}/${target.name}`);
			return Promise.resolve(results[target.repositoryId] ?? "denied");
		},
	};
}

describe("decision watch requests", () => {
	it("accepts bounded repository lists with loaded document ids", () => {
		expect(watchRequest([repository("score", [DOCUMENT, DOCUMENT])])).toEqual([
			repository("score", [DOCUMENT]),
		]);
		expect(watchRequest([])).toEqual([]);
	});

	it("refuses frames over the repository or document bound", () => {
		let repositories = Array.from(
			{ length: MAX_WATCH_FRAME_REPOSITORIES + 1 },
			(_, index) => repository(`archive-${index}`),
		);
		expect(watchRequest(repositories)).toBeUndefined();
		expect(watchRequest(repositories.slice(0, MAX_WATCH_FRAME_REPOSITORIES))).toHaveLength(
			MAX_WATCH_FRAME_REPOSITORIES,
		);
		let documents = Array.from(
			{ length: MAX_WATCHED_DOCUMENTS + 1 },
			(_, index) => `cccccccc-0000-4000-8000-${String(index).padStart(12, "0")}`,
		);
		expect(watchRequest([repository("score", documents)])).toBeUndefined();
	});

	it("refuses malformed or duplicate entries", () => {
		expect(watchRequest("score")).toBeUndefined();
		expect(watchRequest([repository("score"), repository("score")])).toBeUndefined();
		expect(watchRequest([{ ...repository("score"), owner: "../octo" }])).toBeUndefined();
		expect(watchRequest([{ ...repository("score"), name: "a/b" }])).toBeUndefined();
		expect(watchRequest([{ ...repository("score"), channelIds: ["../x"] }])).toBeUndefined();
		expect(watchRequest([{ ...repository("score"), repositoryId: "" }])).toBeUndefined();
	});

	it("bounds unwatch lists and rejects malformed repository ids", () => {
		expect(unwatchRequest(["R_a", "R_a", "R_b"])).toEqual(["R_a", "R_b"]);
		expect(unwatchRequest(["R a"])).toBeUndefined();
		expect(unwatchRequest("R_a")).toBeUndefined();
		let ids = Array.from({ length: MAX_WATCHED_REPOSITORIES + 1 }, (_, index) => `R_${index}`);
		expect(unwatchRequest(ids)).toBeUndefined();
		expect(unwatchRequest(ids.slice(1))).toHaveLength(MAX_WATCHED_REPOSITORIES);
	});
});

describe("decision watch subscriptions", () => {
	it("subscribes only repositories that pass a fresh read check", async () => {
		let watch = decisionWatch();
		let bus = topics();
		let github = access({ R_archive: "allowed", R_secret: "denied", R_flaky: "unavailable" });
		let outcome = await watchDecisions(
			watch,
			[repository("archive", [DOCUMENT]), repository("secret"), repository("flaky")],
			github.authorize,
			bus,
		);
		expect(github.asked).toEqual(["octo-org/archive", "octo-org/secret", "octo-org/flaky"]);
		expect(outcome).toEqual({
			watched: [repository("archive", [DOCUMENT])],
			refused: ["R_secret"],
			unavailable: ["R_flaky"],
		});
		expect([...bus.subscribed]).toEqual(["R_archive"]);
		expect([...watch.repositories.keys()]).toEqual(["R_archive"]);
		expect(watch.authorizing.size).toBe(0);
	});

	it("reads access by name but trusts only the stored repository node ID", async () => {
		let reads: Record<string, { id: string; permissions: { pull: boolean } } | Error> = {
			"octo-org/renamed": { id: "R_other", permissions: { pull: true } },
			"octo-org/hidden": { id: "R_hidden", permissions: { pull: false } },
			"octo-org/readable": { id: "R_readable", permissions: { pull: true } },
			"octo-org/limited": new GitHubError("rate limited", 429),
			"octo-org/gone": new GitHubError("not found", 404),
		};
		let authorize = repositoryReader((owner, name) => {
			let read = reads[`${owner}/${name}`];
			return read instanceof Error ? Promise.reject(read) : Promise.resolve(read);
		});
		let results = await Promise.all(
			["renamed", "hidden", "readable", "limited", "gone", "missing"].map(name =>
				authorize(repository(name))
			),
		);
		expect(results).toEqual(["denied", "denied", "allowed", "unavailable", "denied", "denied"]);
		let watch = decisionWatch();
		let bus = topics();
		let outcome = await watchDecisions(
			watch,
			[repository("renamed"), repository("readable")],
			authorize,
			bus,
		);
		expect(outcome.refused).toEqual(["R_renamed"]);
		expect([...bus.subscribed]).toEqual(["R_readable"]);
	});

	it("adds repositories across frames and drops only the ones unwatched", async () => {
		let watch = decisionWatch();
		let bus = topics();
		let github = access({ R_a: "allowed", R_b: "allowed", R_c: "allowed" });
		await watchDecisions(watch, [repository("a"), repository("b")], github.authorize, bus);
		await watchDecisions(watch, [repository("c")], github.authorize, bus);
		unwatchDecisions(watch, ["R_a", "R_missing"], bus);
		expect(bus.log).toEqual(["+R_a", "+R_b", "+R_c", "-R_a"]);
		expect([...watch.repositories.keys()].sort()).toEqual(["R_b", "R_c"]);
	});

	it("reconciles newly loaded documents of a watched repository without another GitHub check", async () => {
		let watch = decisionWatch();
		let bus = topics();
		let github = access({ R_score: "allowed" });
		await watchDecisions(watch, [repository("score")], github.authorize, bus);
		let outcome = await watchDecisions(
			watch,
			[repository("score", [DOCUMENT])],
			github.authorize,
			bus,
		);
		expect(github.asked).toEqual(["octo-org/score"]);
		expect(outcome.watched).toEqual([repository("score", [DOCUMENT])]);
		expect(bus.log).toEqual(["+R_score"]);
	});

	it("rechecks a renamed repository and keeps its subscription through an outage", async () => {
		let watch = decisionWatch();
		let bus = topics();
		await watchDecisions(watch, [repository("score")], () => Promise.resolve("allowed"), bus);
		let renamed = { ...repository("score"), name: "score-renamed" };
		let outage = await watchDecisions(watch, [renamed], () => Promise.resolve("unavailable"), bus);
		expect(outage.unavailable).toEqual(["R_score"]);
		expect([...bus.subscribed]).toEqual(["R_score"]);
		expect(watch.repositories.get("R_score")?.name).toBe("score");
		let denied = await watchDecisions(watch, [renamed], () => Promise.resolve("denied"), bus);
		expect(denied.refused).toEqual(["R_score"]);
		expect(bus.subscribed.size).toBe(0);
	});

	it("shares one check between overlapping frames for the same repository", async () => {
		let watch = decisionWatch();
		let bus = topics();
		let check = Promise.withResolvers<AuthorizationResult>();
		let asked = 0;
		let authorize = () => {
			asked++;
			return check.promise;
		};
		let first = watchDecisions(watch, [repository("score")], authorize, bus);
		let second = watchDecisions(watch, [repository("score", [DOCUMENT])], authorize, bus);
		check.resolve("allowed");
		expect((await first).watched).toEqual([repository("score")]);
		expect((await second).watched).toEqual([repository("score", [DOCUMENT])]);
		expect(asked).toBe(1);
		expect(bus.log).toEqual(["+R_score"]);
	});

	it("refuses repositories beyond the per-socket limit", async () => {
		let watch = decisionWatch();
		let bus = topics();
		let allowed = () => Promise.resolve<AuthorizationResult>("allowed");
		for (let start = 0; start < MAX_WATCHED_REPOSITORIES; start += MAX_WATCH_FRAME_REPOSITORIES) {
			await watchDecisions(
				watch,
				Array.from(
					{ length: MAX_WATCH_FRAME_REPOSITORIES },
					(_, index) => repository(`archive-${start + index}`),
				),
				allowed,
				bus,
			);
		}
		expect(watch.repositories.size).toBe(MAX_WATCHED_REPOSITORIES);
		let outcome = await watchDecisions(
			watch,
			[repository("archive-0", [DOCUMENT]), repository("overflow")],
			allowed,
			bus,
		);
		expect(outcome.watched).toEqual([repository("archive-0", [DOCUMENT])]);
		expect(outcome.refused).toEqual(["R_overflow"]);
		expect(bus.subscribed.has("R_overflow")).toBe(false);
	});

	it("omits and never subscribes a repository unwatched while its check ran", async () => {
		let watch = decisionWatch();
		let bus = topics();
		let check = Promise.withResolvers<AuthorizationResult>();
		let pending = watchDecisions(watch, [repository("score")], () => check.promise, bus);
		unwatchDecisions(watch, ["R_score"], bus);
		check.resolve("allowed");
		expect(await pending).toEqual({ watched: [], refused: [], unavailable: [] });
		expect(bus.subscribed.size).toBe(0);
	});

	it("subscribes a repository refused during an outage once a later watch succeeds", async () => {
		let watch = decisionWatch();
		let bus = topics();
		let outage = access({ R_other: "unavailable" });
		let first = await watchDecisions(watch, [repository("other")], outage.authorize, bus);
		expect(first.unavailable).toEqual(["R_other"]);
		expect(bus.subscribed.size).toBe(0);
		expect(watch.authorizing.size).toBe(0);
		let recovered = access({ R_other: "allowed" });
		let retry = await watchDecisions(
			watch,
			[repository("other", [DOCUMENT])],
			recovered.authorize,
			bus,
		);
		expect(recovered.asked).toEqual(["octo-org/other"]);
		expect(retry.watched).toEqual([repository("other", [DOCUMENT])]);
		expect([...bus.subscribed]).toEqual(["R_other"]);
	});

	it("treats a throwing check as unavailable rather than allowed", async () => {
		let watch = decisionWatch();
		let bus = topics();
		let outcome = await watchDecisions(
			watch,
			[repository("score")],
			() => Promise.reject(new Error("socket reset")),
			bus,
		);
		expect(outcome.unavailable).toEqual(["R_score"]);
		expect(bus.subscribed.size).toBe(0);
	});

	it("drops revoked repositories on recheck but keeps them through outages", async () => {
		let watch = decisionWatch();
		let bus = topics();
		await watchDecisions(
			watch,
			[repository("revoked"), repository("outage"), repository("kept")],
			() => Promise.resolve("allowed"),
			bus,
		);
		let github = access({ R_revoked: "denied", R_outage: "unavailable", R_kept: "allowed" });
		await recheckDecisionWatch(watch, github.authorize, bus);
		expect([...bus.subscribed].sort()).toEqual(["R_kept", "R_outage"]);
		expect([...watch.repositories.keys()].sort()).toEqual(["R_kept", "R_outage"]);
	});

	it("unsubscribes everything on release and ignores checks still in flight", async () => {
		let watch = decisionWatch();
		let bus = topics();
		await watchDecisions(watch, [repository("a")], () => Promise.resolve("allowed"), bus);
		let pending = Promise.withResolvers<AuthorizationResult>();
		let late = watchDecisions(watch, [repository("b")], () => pending.promise, bus);
		releaseDecisionWatch(watch, bus);
		pending.resolve("allowed");
		expect(await late).toEqual({ watched: [], refused: [], unavailable: [] });
		expect(bus.subscribed.size).toBe(0);
		expect(watch.repositories.size).toBe(0);
		expect(
			(await watchDecisions(watch, [repository("c")], () => Promise.resolve("allowed"), bus))
				.watched,
		)
			.toEqual([]);
	});
});
