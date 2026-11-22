import type { ChannelRecord, Lease } from "../storage/model";
import type { StorageAdapter } from "../storage/port";

/** How long a deleted document is remembered, so a delete repeated meanwhile is answered alike. */
export const DELETED_REMEMBERED_MS = 10 * 60_000;
/** The most deleted documents remembered at once; the oldest is forgotten first. */
const DELETED_REMEMBERED = 1_000;

/** Who deleted a document: their user id and GitHub login. */
export type Deleter = { id: string; login: string };

export type DeleteOutcome =
	/** Deleted now, or moments ago by a delete this one waited behind or repeats. */
	| { kind: "deleted"; deleted: ChannelRecord[]; by: Deleter }
	| { kind: "missing" }
	/** A child goes only with its parent. */
	| { kind: "child" }
	/** A build or run on a machine holds the document, or one of its children. */
	| { kind: "running"; message: string };

export type DocumentDeletionDeps = {
	storage: Pick<StorageAdapter, "channels">;
	lease: () => Lease;
	/** Documents being deleted: while one is here, nothing starts work on it or opens it. */
	deleting: Set<string>;
	/** Serializes a delete with the document's archive, restore and other deletes. */
	transition: <T>(id: string, action: () => Promise<T>) => Promise<T>;
	/** The children of a document that may have anything working on them: listed, or open. */
	children: (document: ChannelRecord) => Promise<string[]>;
	/** Why the documents can't be deleted now: a build or run on a machine holds one. */
	running: (ids: string[]) => Promise<string | undefined>;
	/**
	 * Everything working on one document stops, for good if the delete commits: its room's
	 * editing, its Planner and that Planner's AI launches and remote hold, its jobs and research.
	 */
	stop: (id: string) => Promise<void>;
	/** The delete did not commit: the documents are served again as they were. */
	resume: (ids: string[]) => Promise<void>;
	/** After the commit, and only then: everyone who has them open, and their sidebars, hear. */
	deleted: (deleted: ChannelRecord[], by: Deleter) => void;
	clock: () => number;
};

/** A build began while the document's work was being stopped; its message says so. */
class Running extends Error {}

/**
 * Deleting a document for good, with its children: stop everything that works on them, delete
 * every row in one transaction under the writer lease, and only then tell anyone. A repeated or
 * concurrent delete is answered as the first was.
 */
export class DocumentDeletion {
	readonly #recent = new Map<string, { deleted: ChannelRecord[]; by: Deleter; at: number }>();

	constructor(private deps: DocumentDeletionDeps) {}

	/**
	 * The document as it was, if this process deleted it moments ago, so a repeated delete is
	 * authorized against it and answered as the first was.
	 */
	recent(id: string): { channel: ChannelRecord; by: Deleter } | undefined {
		let found = this.#remembered(id);
		let channel = found?.deleted.find(item => item.id === id);
		return found && channel && { channel, by: found.by };
	}

	delete(id: string, by: Deleter): Promise<DeleteOutcome> {
		return this.deps.transition(id, () => this.#delete(id, by));
	}

	async #delete(id: string, by: Deleter): Promise<DeleteOutcome> {
		let channel = await this.deps.storage.channels.get(id);
		if (!channel) {
			// Deleted by the delete this one waited behind, or repeats: answered as that one was.
			let recent = this.#remembered(id);
			return recent
				? { kind: "deleted", deleted: recent.deleted, by: recent.by }
				: { kind: "missing" };
		}
		if (channel.parentChannelId) return { kind: "child" };
		let ids = [channel.id, ...await this.deps.children(channel)];
		// Refused before anything is disturbed, and checked again once nothing can start.
		let running = await this.deps.running(ids);
		if (running) return { kind: "running", message: running };
		for (let item of ids) this.deps.deleting.add(item);
		let deleted: ChannelRecord[];
		try {
			// The children stop before their parent, whose Planner reaches them.
			for (let item of ids.toReversed()) await this.deps.stop(item);
			let started = await this.deps.running(ids);
			if (started) throw new Running(started);
			deleted = await this.deps.storage.channels.delete({ id, lease: this.deps.lease() });
		} catch (error) {
			for (let item of ids) this.deps.deleting.delete(item);
			await this.deps.resume(ids).catch(err =>
				console.error("chopin: could not serve a document again after its delete failed -", err)
			);
			if (error instanceof Running) return { kind: "running", message: error.message };
			throw error;
		}
		if (!deleted.length) {
			for (let item of ids) this.deps.deleting.delete(item);
			return { kind: "missing" };
		}
		this.#remember(deleted, by);
		try {
			this.deps.deleted(deleted, by);
		} finally {
			for (let item of ids) this.deps.deleting.delete(item);
		}
		return { kind: "deleted", deleted, by };
	}

	#remembered(id: string) {
		let found = this.#recent.get(id);
		if (found && this.deps.clock() - found.at >= DELETED_REMEMBERED_MS) {
			for (let item of found.deleted) this.#recent.delete(item.id);
			return undefined;
		}
		return found;
	}

	#remember(deleted: ChannelRecord[], by: Deleter) {
		let entry = { deleted, by, at: this.deps.clock() };
		for (let item of deleted) {
			this.#recent.delete(item.id);
			this.#recent.set(item.id, entry);
		}
		while (this.#recent.size > DELETED_REMEMBERED) {
			this.#recent.delete(this.#recent.keys().next().value!);
		}
	}
}
