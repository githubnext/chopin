import { isChannelId } from "../channels/id";
import { GitHubError } from "../github/client";

import type { Session } from "@chopin/protocol";
import type { AuthorizationResult } from "../wire";

export const MAX_WATCHED_REPOSITORIES = 50;
export const MAX_WATCHED_DOCUMENTS = 500;

const REPOSITORY_ID = /^[A-Za-z0-9_=+/-]{1,200}$/;
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const REPOSITORY = /^[A-Za-z0-9._-]{1,100}$/;

export type WatchedRepository = Session.WatchedRepository;
export type RepositoryIdentity = Omit<WatchedRepository, "channelIds">;

export type DecisionWatch = {
	generation: number;
	repositories: Map<string, RepositoryIdentity>;
};

export type WatchTopics = {
	subscribe(repositoryId: string): void;
	unsubscribe(repositoryId: string): void;
};

export type RepositoryAuthorizer = (repository: RepositoryIdentity) => Promise<AuthorizationResult>;

export type WatchOutcome = { watched: WatchedRepository[]; refused: string[] };

export function decisionWatch(): DecisionWatch {
	return { generation: 0, repositories: new Map() };
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

export function watchedRepositories(value: unknown): WatchedRepository[] | undefined {
	if (!Array.isArray(value) || value.length > MAX_WATCHED_REPOSITORIES) return undefined;
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

function authorizeAll(
	repositories: RepositoryIdentity[],
	authorize: RepositoryAuthorizer,
): Promise<AuthorizationResult[]> {
	return Promise.all(
		repositories.map(repository =>
			authorize(repository).catch((): AuthorizationResult => "unavailable")
		),
	);
}

export async function watchDecisions(
	watch: DecisionWatch,
	ownRepositoryId: string,
	requested: WatchedRepository[],
	authorize: RepositoryAuthorizer,
	topics: WatchTopics,
	open: () => boolean,
): Promise<WatchOutcome | undefined> {
	let generation = ++watch.generation;
	let others = requested.filter(repository => repository.repositoryId !== ownRepositoryId);
	let results = await authorizeAll(others, authorize);
	if (!open() || watch.generation !== generation) return undefined;
	let allowed = new Set(
		others.filter((_, index) => results[index] === "allowed")
			.map(repository => repository.repositoryId),
	);
	let next = new Map<string, RepositoryIdentity>();
	for (let { repositoryId, owner, name } of others) {
		if (allowed.has(repositoryId)) next.set(repositoryId, { repositoryId, owner, name });
	}
	for (let repositoryId of watch.repositories.keys()) {
		if (!next.has(repositoryId)) topics.unsubscribe(repositoryId);
	}
	for (let repositoryId of next.keys()) {
		if (!watch.repositories.has(repositoryId)) topics.subscribe(repositoryId);
	}
	watch.repositories = next;
	return {
		watched: requested.filter(repository =>
			repository.repositoryId === ownRepositoryId || allowed.has(repository.repositoryId)
		),
		refused: others.filter(repository => !allowed.has(repository.repositoryId))
			.map(repository => repository.repositoryId),
	};
}

export async function recheckDecisionWatch(
	watch: DecisionWatch,
	authorize: RepositoryAuthorizer,
	topics: WatchTopics,
	open: () => boolean,
): Promise<void> {
	let generation = watch.generation;
	let current = [...watch.repositories.values()];
	if (current.length === 0) return;
	let results = await authorizeAll(current, authorize);
	if (!open() || watch.generation !== generation) return;
	current.forEach((repository, index) => {
		if (results[index] !== "denied") return;
		watch.repositories.delete(repository.repositoryId);
		topics.unsubscribe(repository.repositoryId);
	});
}

export function releaseDecisionWatch(watch: DecisionWatch, topics: WatchTopics): void {
	watch.generation++;
	for (let repositoryId of watch.repositories.keys()) topics.unsubscribe(repositoryId);
	watch.repositories.clear();
}
