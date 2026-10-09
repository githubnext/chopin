import { isChannelId } from "../channels/id";
import { GitHubError } from "../github/client";

import type { Sidebar } from "@chopin/protocol";
import type { AuthorizationResult } from "../wire";

export const MAX_WATCH_FRAME_REPOSITORIES = 50;
export const MAX_WATCHED_REPOSITORIES = 200;
export const MAX_WATCHED_DOCUMENTS = 500;

const REPOSITORY_ID = /^[A-Za-z0-9_=+/-]{1,200}$/;
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const REPOSITORY = /^[A-Za-z0-9._-]{1,100}$/;

export type WatchedRepository = Sidebar.WatchedRepository;
export type RepositoryIdentity = Omit<WatchedRepository, "channelIds">;

type RepositoryOutcome = "watched" | "refused" | "unavailable" | "superseded";

type Authorization = {
	identity: RepositoryIdentity;
	outcome: Promise<RepositoryOutcome>;
};

export type DecisionWatch = {
	repositories: Map<string, RepositoryIdentity>;
	authorizing: Map<string, Authorization>;
	released: boolean;
};

export type WatchTopics = {
	subscribe(repositoryId: string): void;
	unsubscribe(repositoryId: string): void;
};

export type RepositoryAuthorizer = (repository: RepositoryIdentity) => Promise<AuthorizationResult>;

export type WatchOutcome = {
	watched: WatchedRepository[];
	refused: string[];
	unavailable: string[];
};

export function decisionWatch(): DecisionWatch {
	return { repositories: new Map(), authorizing: new Map(), released: false };
}

type RepositoryRead = (
	owner: string,
	name: string,
) => Promise<{ id: string; permissions: { pull: boolean } } | undefined>;

export function repositoryReader(read: RepositoryRead): RepositoryAuthorizer {
	return async repository => {
		try {
			let found = await read(repository.owner, repository.name);
			return found?.id === repository.repositoryId && found.permissions.pull
				? "allowed"
				: "denied";
		} catch (err) {
			return err instanceof GitHubError
					&& (err.status === 429 || err.status === 502 || err.status === 503)
				? "unavailable"
				: "denied";
		}
	};
}

function text(value: unknown, pattern: RegExp): value is string {
	return typeof value === "string" && pattern.test(value);
}

export function watchRequest(value: unknown): WatchedRepository[] | undefined {
	if (!Array.isArray(value) || value.length > MAX_WATCH_FRAME_REPOSITORIES) return undefined;
	let seen = new Set<string>();
	let repositories: WatchedRepository[] = [];
	for (let entry of value) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
		let { repositoryId, owner, name, channelIds } = entry as Record<string, unknown>;
		if (!text(repositoryId, REPOSITORY_ID) || seen.has(repositoryId)) return undefined;
		if (!text(owner, OWNER) || !text(name, REPOSITORY)) return undefined;
		if (
			!Array.isArray(channelIds) || channelIds.length > MAX_WATCHED_DOCUMENTS
			|| !channelIds.every(id => typeof id === "string" && isChannelId(id))
		) return undefined;
		seen.add(repositoryId);
		repositories.push({ repositoryId, owner, name, channelIds: [...new Set(channelIds)] });
	}
	return repositories;
}

export function unwatchRequest(value: unknown): string[] | undefined {
	if (!Array.isArray(value) || value.length > MAX_WATCHED_REPOSITORIES) return undefined;
	if (!value.every(id => text(id, REPOSITORY_ID))) return undefined;
	return [...new Set(value as string[])];
}

function sameRepository(
	current: RepositoryIdentity | undefined,
	requested: RepositoryIdentity,
): boolean {
	return current?.repositoryId === requested.repositoryId
		&& current.owner === requested.owner
		&& current.name === requested.name;
}

function tracked(watch: DecisionWatch): number {
	let ids = new Set(watch.repositories.keys());
	for (let id of watch.authorizing.keys()) ids.add(id);
	return ids.size;
}

function drop(watch: DecisionWatch, repositoryId: string, topics: WatchTopics): void {
	if (!watch.repositories.delete(repositoryId)) return;
	topics.unsubscribe(repositoryId);
}

function authorizeRepository(
	watch: DecisionWatch,
	identity: RepositoryIdentity,
	authorize: RepositoryAuthorizer,
	topics: WatchTopics,
): Authorization {
	let id = identity.repositoryId;
	let authorization: Authorization = {
		identity,
		outcome: Promise.resolve()
			.then(() => authorize(identity))
			.catch((): AuthorizationResult => "unavailable")
			.then(result => {
				if (watch.released || watch.authorizing.get(id) !== authorization) return "superseded";
				watch.authorizing.delete(id);
				if (result === "unavailable") return "unavailable";
				if (result === "denied") {
					drop(watch, id, topics);
					return "refused";
				}
				if (!watch.repositories.has(id)) topics.subscribe(id);
				watch.repositories.set(id, identity);
				return "watched";
			}),
	};
	watch.authorizing.set(id, authorization);
	return authorization;
}

function watchRepository(
	watch: DecisionWatch,
	{ repositoryId, owner, name }: WatchedRepository,
	authorize: RepositoryAuthorizer,
	topics: WatchTopics,
): Promise<RepositoryOutcome> {
	let identity = { repositoryId, owner, name };
	if (watch.released) return Promise.resolve("superseded");
	if (sameRepository(watch.repositories.get(repositoryId), identity)) {
		return Promise.resolve("watched");
	}
	let pending = watch.authorizing.get(repositoryId);
	if (pending && sameRepository(pending.identity, identity)) return pending.outcome;
	let known = watch.repositories.has(repositoryId) || !!pending;
	if (!known && tracked(watch) >= MAX_WATCHED_REPOSITORIES) return Promise.resolve("refused");
	return authorizeRepository(watch, identity, authorize, topics).outcome;
}

export async function watchDecisions(
	watch: DecisionWatch,
	requested: WatchedRepository[],
	authorize: RepositoryAuthorizer,
	topics: WatchTopics,
): Promise<WatchOutcome> {
	let outcomes = await Promise.all(
		requested.map(repository => watchRepository(watch, repository, authorize, topics)),
	);
	let result: WatchOutcome = { watched: [], refused: [], unavailable: [] };
	requested.forEach((repository, index) => {
		let outcome = outcomes[index];
		if (outcome === "watched") result.watched.push(repository);
		else if (outcome === "refused") result.refused.push(repository.repositoryId);
		else if (outcome === "unavailable") result.unavailable.push(repository.repositoryId);
	});
	return result;
}

export function unwatchDecisions(
	watch: DecisionWatch,
	repositoryIds: string[],
	topics: WatchTopics,
): void {
	for (let repositoryId of repositoryIds) {
		watch.authorizing.delete(repositoryId);
		drop(watch, repositoryId, topics);
	}
}

export async function recheckDecisionWatch(
	watch: DecisionWatch,
	authorize: RepositoryAuthorizer,
	topics: WatchTopics,
): Promise<void> {
	let current = [...watch.repositories.values()];
	let results = await Promise.all(
		current.map(repository =>
			authorize(repository).catch((): AuthorizationResult => "unavailable")
		),
	);
	current.forEach((repository, index) => {
		if (results[index] !== "denied" || watch.released) return;
		if (watch.repositories.get(repository.repositoryId) !== repository) return;
		drop(watch, repository.repositoryId, topics);
	});
}

export function releaseDecisionWatch(watch: DecisionWatch, topics: WatchTopics): void {
	watch.released = true;
	for (let repositoryId of watch.repositories.keys()) topics.unsubscribe(repositoryId);
	watch.repositories.clear();
	watch.authorizing.clear();
}
