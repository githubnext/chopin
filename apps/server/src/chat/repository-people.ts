/**
 * The people who can read a document's repository, with their GitHub avatars, read as the caller's
 * own session so what is offered respects their GitHub permissions. Kept briefly per session and
 * repository so opening `@` does not ask GitHub on every keystroke. When GitHub refuses to list
 * collaborators (for example for a read-only viewer on a repository whose collaborator list is
 * restricted), `undefined` lets the route fall back to the document's known authors.
 */

import { GitHubError } from "../github/client";

import type { DocumentPerson } from "@chopin/protocol/mention-sources";

export type PeopleRepositoryTarget = { id: string; owner: string; name: string };

const REMOTE_TTL_MS = 60_000;

export type RepositoryPeopleOptions = {
	remote?: (
		sessionId: string,
		repository: PeopleRepositoryTarget,
	) => Promise<DocumentPerson[] | undefined>;
	clock?: () => number;
};

type Held = { at: number; listing: Promise<DocumentPerson[] | undefined> };

export class RepositoryPeople {
	#options: RepositoryPeopleOptions;
	#held = new Map<string, Held>();

	constructor(options: RepositoryPeopleOptions) {
		this.#options = options;
	}

	#now(): number {
		return (this.#options.clock ?? Date.now)();
	}

	async list(
		repository: PeopleRepositoryTarget,
		sessionId: string | undefined,
	): Promise<DocumentPerson[] | undefined> {
		let remote = this.#options.remote;
		if (!remote || !sessionId) return undefined;
		let key = `${sessionId}:${repository.id}`;
		let now = this.#now();
		let held = this.#held.get(key);
		if (!held || now - held.at >= REMOTE_TTL_MS) {
			held = {
				at: now,
				listing: (async () => {
					try {
						return await remote(sessionId, repository);
					} catch (error) {
						if (error instanceof GitHubError && (error.status === 403 || error.status === 404)) {
							return undefined;
						}
						console.error("[chat] could not list the repository's collaborators:", error);
						return undefined;
					}
				})(),
			};
			this.#held.set(key, held);
			let kept = held;
			void kept.listing.then(listing => {
				if (!listing && this.#held.get(key) === kept) this.#held.delete(key);
			});
		}
		return held.listing;
	}
}
