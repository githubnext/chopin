import { describe, expect, it } from "bun:test";

import { GitHubError } from "../github/client";

import {
	decisionWatch,
	MAX_WATCHED_DOCUMENTS,
	MAX_WATCHED_REPOSITORIES,
	recheckDecisionWatch,
	releaseDecisionWatch,
	repositoryReader,
	watchDecisions,
	watchedRepositories,
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
		expect(watchedRepositories([repository("score", [DOCUMENT, DOCUMENT])])).toEqual([
			repository("score", [DOCUMENT]),
		]);
		expect(watchedRepositories([])).toEqual([]);
	});

	it("refuses lists over the repository or document bound", () => {
		let repositories = Array.from(
			{ length: MAX_WATCHED_REPOSITORIES + 1 },
			(_, index) => repository(`archive-${index}`),
		);
		expect(watchedRepositories(repositories)).toBeUndefined();
		expect(watchedRepositories(repositories.slice(0, MAX_WATCHED_REPOSITORIES))).toHaveLength(
			MAX_WATCHED_REPOSITORIES,
		);
		let documents = Array.from(
			{ length: MAX_WATCHED_DOCUMENTS + 1 },
			(_, index) => `cccccccc-0000-4000-8000-${String(index).padStart(12, "0")}`,
		);
		expect(watchedRepositories([repository("score", documents)])).toBeUndefined();
	});

	it("refuses malformed or duplicate entries", () => {
		expect(watchedRepositories("score")).toBeUndefined();
		expect(watchedRepositories([repository("score"), repository("score")])).toBeUndefined();
		expect(watchedRepositories([{ ...repository("score"), owner: "../octo" }])).toBeUndefined();
		expect(watchedRepositories([{ ...repository("score"), name: "a/b" }])).toBeUndefined();
		expect(watchedRepositories([{ ...repository("score"), channelIds: ["../x"] }]))
			.toBeUndefined();
		expect(watchedRepositories([{ ...repository("score"), repositoryId: "" }])).toBeUndefined();
	});
});

describe("decision watch subscriptions", () => {
	it("subscribes only repositories that pass a fresh read check", async () => {
		let watch = decisionWatch();
		let bus = topics();
		let github = access({ R_archive: "allowed", R_secret: "denied", R_flaky: "unavailable" });
		let outcome = await watchDecisions(
			watch,
			"R_score",
			[
				repository("score", [DOCUMENT]),
				repository("archive"),
				repository("secret"),
				repository(
					"flaky",
				),
			],
			github.authorize,
			bus,
			() => true,
		);
		expect(github.asked).toEqual(["octo-org/archive", "octo-org/secret", "octo-org/flaky"]);
		expect(outcome).toEqual({
			watched: [repository("score", [DOCUMENT]), repository("archive")],
			refused: ["R_secret", "R_flaky"],
		});
		expect([...bus.subscribed]).toEqual(["R_archive"]);
		expect([...watch.repositories.keys()]).toEqual(["R_archive"]);
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
			"R_score",
			[repository("renamed"), repository("readable")],
			authorize,
			bus,
			() => true,
		);
		expect(outcome?.refused).toEqual(["R_renamed"]);
		expect([...bus.subscribed]).toEqual(["R_readable"]);
	});

	it("unsubscribes repositories that leave the list and keeps the ones that stay", async () => {
		let watch = decisionWatch();
		let bus = topics();
		let github = access({ R_a: "allowed", R_b: "allowed", R_c: "allowed" });
		await watchDecisions(
			watch,
			"R_score",
			[repository("a"), repository("b")],
			github.authorize,
			bus,
			() => true,
		);
		await watchDecisions(
			watch,
			"R_score",
			[repository("b"), repository("c")],
			github.authorize,
			bus,
			() => true,
		);
		expect(bus.log).toEqual(["+R_a", "+R_b", "-R_a", "+R_c"]);
		await watchDecisions(watch, "R_score", [], github.authorize, bus, () => true);
		expect(bus.subscribed.size).toBe(0);
	});

	it("lets the latest request win when checks overlap", async () => {
		let watch = decisionWatch();
		let bus = topics();
		let slow = Promise.withResolvers<AuthorizationResult>();
		let first = watchDecisions(
			watch,
			"R_score",
			[repository("slow")],
			() => slow.promise,
			bus,
			() => true,
		);
		let second = await watchDecisions(
			watch,
			"R_score",
			[repository("fast")],
			() => Promise.resolve("allowed"),
			bus,
			() => true,
		);
		slow.resolve("allowed");
		expect(await first).toBeUndefined();
		expect(second?.watched).toEqual([repository("fast")]);
		expect([...bus.subscribed]).toEqual(["R_fast"]);
	});

	it("changes nothing for a socket that closed while checks ran", async () => {
		let watch = decisionWatch();
		let bus = topics();
		let outcome = await watchDecisions(
			watch,
			"R_score",
			[repository("archive")],
			() => Promise.resolve("allowed"),
			bus,
			() => false,
		);
		expect(outcome).toBeUndefined();
		expect(bus.subscribed.size).toBe(0);
	});

	it("drops revoked repositories on recheck but keeps them through outages", async () => {
		let watch = decisionWatch();
		let bus = topics();
		await watchDecisions(
			watch,
			"R_score",
			[repository("revoked"), repository("outage"), repository("kept")],
			() => Promise.resolve("allowed"),
			bus,
			() => true,
		);
		let github = access({ R_revoked: "denied", R_outage: "unavailable", R_kept: "allowed" });
		await recheckDecisionWatch(watch, github.authorize, bus, () => true);
		expect([...bus.subscribed].sort()).toEqual(["R_kept", "R_outage"]);
		expect([...watch.repositories.keys()].sort()).toEqual(["R_kept", "R_outage"]);
	});

	it("unsubscribes everything on release and ignores checks still in flight", async () => {
		let watch = decisionWatch();
		let bus = topics();
		await watchDecisions(
			watch,
			"R_score",
			[repository("a")],
			() => Promise.resolve("allowed"),
			bus,
			() => true,
		);
		let pending = Promise.withResolvers<AuthorizationResult>();
		let late = watchDecisions(
			watch,
			"R_score",
			[repository("b")],
			() => pending.promise,
			bus,
			() => true,
		);
		releaseDecisionWatch(watch, bus);
		pending.resolve("allowed");
		expect(await late).toBeUndefined();
		expect(bus.subscribed.size).toBe(0);
		expect(watch.repositories.size).toBe(0);
	});
});
