/**
 * The files of a document's repository that a person can mention in Chat, and whether a path is
 * one. A document with a checkout on this machine lists that checkout (what `git` tracks and
 * what it has not yet ignored); every other lists what GitHub says the default branch holds,
 * read with the sender's own session, so what is offered is what that person can read. A listing
 * is kept briefly, so a room typing `@` does not list a repository per keystroke. Where neither
 * can list, no file is offered and none is accepted.
 */

export type FileListing = { paths: string[]; truncated: boolean };
export type RepositoryTarget = { id: string; owner: string; name: string; defaultBranch: string };

/** More than this and the list is cut, as GitHub's own tree is. */
export const MAX_FILES = 50_000;
const REMOTE_TTL_MS = 60_000;
const CHECKOUT_TTL_MS = 10_000;

export type RepositoryFilesOptions = {
	/** A verified checkout of the document's repository on this machine, if it has one. */
	checkout?: (channelId: string, repository: RepositoryTarget) => Promise<string | undefined>;
	/** What GitHub lists for the repository, read as the session; undefined when it cannot say. */
	remote?: (sessionId: string, repository: RepositoryTarget) => Promise<FileListing | undefined>;
	clock?: () => number;
};

/** The files a checkout holds: tracked, and untracked unless ignored. Undefined if it cannot say. */
export async function checkoutFiles(directory: string): Promise<FileListing | undefined> {
	try {
		let listed = Bun.spawn(
			["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
			{
				cwd: directory,
				stdout: "pipe",
				stderr: "ignore",
				env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
			},
		);
		let text = await new Response(listed.stdout).text();
		if (await listed.exited !== 0) return undefined;
		let paths = [...new Set(text.split("\0").filter(Boolean))].sort();
		return paths.length > MAX_FILES
			? { paths: paths.slice(0, MAX_FILES), truncated: true }
			: { paths, truncated: false };
	} catch {
		return undefined;
	}
}

type Held = { at: number; listing: Promise<FileListing | undefined> };

export class RepositoryFiles {
	#options: RepositoryFilesOptions;
	#held = new Map<string, Held>();

	constructor(options: RepositoryFilesOptions) {
		this.#options = options;
	}

	#now(): number {
		return (this.#options.clock ?? Date.now)();
	}

	#keep(key: string, ttl: number, read: () => Promise<FileListing | undefined>) {
		let now = this.#now();
		let held = this.#held.get(key);
		if (!held || now - held.at >= ttl) {
			held = { at: now, listing: read() };
			this.#held.set(key, held);
			let kept = held;
			// A listing that failed is read again next time, not kept.
			void kept.listing.then(
				listing => {
					if (!listing && this.#held.get(key) === kept) this.#held.delete(key);
				},
				() => {
					if (this.#held.get(key) === kept) this.#held.delete(key);
				},
			);
		}
		return held.listing;
	}

	/** The repository's files, or undefined when nothing can list them. */
	async list(
		channelId: string,
		repository: RepositoryTarget,
		sessionId: string | undefined,
	): Promise<FileListing | undefined> {
		let directory = await this.#options.checkout?.(channelId, repository).catch(() => undefined);
		if (directory) {
			return this.#keep(`checkout:${directory}`, CHECKOUT_TTL_MS, () => checkoutFiles(directory));
		}
		let remote = this.#options.remote;
		if (!remote || !sessionId) return undefined;
		return this.#keep(`remote:${repository.id}`, REMOTE_TTL_MS, async () => {
			try {
				return await remote(sessionId, repository);
			} catch (error) {
				console.error("[chat] could not list the repository's files:", error);
				return undefined;
			}
		});
	}

	/** Whether `path` is one of the repository's files, or undefined when they cannot be listed. */
	async has(
		channelId: string,
		repository: RepositoryTarget,
		sessionId: string | undefined,
		path: string,
	): Promise<boolean | undefined> {
		let listing = await this.list(channelId, repository, sessionId);
		return listing ? listing.paths.includes(path) : undefined;
	}
}

/**
 * The files a typed query points at, best first and no more than `limit`: one whose name starts
 * with it, then one whose path does, then a name, then a path that holds it. Case does not matter.
 * An empty query is the first files, in order.
 */
export function matchFiles(paths: readonly string[], query: string, limit: number): string[] {
	let wanted = query.trimStart().toLowerCase();
	if (!wanted) return paths.slice(0, limit);
	let buckets: string[][] = [[], [], [], []];
	for (let path of paths) {
		let lower = path.toLowerCase();
		let name = lower.slice(lower.lastIndexOf("/") + 1);
		let rank = name.startsWith(wanted)
			? 0
			: lower.startsWith(wanted)
			? 1
			: name.includes(wanted)
			? 2
			: lower.includes(wanted)
			? 3
			: undefined;
		if (rank !== undefined) buckets[rank]!.push(path);
	}
	return buckets.flat().slice(0, limit);
}
