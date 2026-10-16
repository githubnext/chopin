import type { DocumentTarget } from "../plan/service";
import type { StorageAdapter } from "../storage/port";

/** Edits by one author closer together than this read as one session in Activity. */
export const VERSION_IDLE_MS = 10 * 60_000;

/**
 * Records each persisted document change into its editing session.
 *
 * History is derived from commits that already happened, so a failure here is logged and
 * never blocks or rolls back an edit. One document's records run in order, so a session is
 * always extended from the change before it.
 */
export class DocumentHistory {
	#queues = new Map<string, Promise<void>>();

	constructor(
		private storage: StorageAdapter,
		private clock: () => Date = () => new Date(),
	) {}

	record(target: DocumentTarget): Promise<void> {
		let now = this.clock();
		let previous = this.#queues.get(target.channelId) ?? Promise.resolve();
		let next = previous.then(async () => {
			try {
				await this.storage.versions.record({
					channelId: target.channelId,
					...(target.author ? { authorId: target.author } : {}),
					revision: target.revision,
					source: target.source,
					sourceHash: target.sourceHash,
					now,
					idleMs: VERSION_IDLE_MS,
					...(target.newSession ? { newSession: true } : {}),
				});
			} catch (err) {
				console.warn(`[history] could not record a version of ${target.channelId}:`, err);
			}
		});
		this.#queues.set(target.channelId, next);
		void next.then(() => {
			if (this.#queues.get(target.channelId) === next) this.#queues.delete(target.channelId);
		});
		return next;
	}

	/** Settles every pending record, for shutdown. */
	async flush(): Promise<void> {
		await Promise.all(this.#queues.values());
	}
}
