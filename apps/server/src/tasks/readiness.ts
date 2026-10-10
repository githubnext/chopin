import type { JevRequest, JevResult } from "../conversation-plan/jev";
import type { DocumentTarget } from "../plan/service";

export type ReadinessAsk = (request: JevRequest) => Promise<JevResult>;

export type ReadinessOptions = {
	current: (channelId: string) => Promise<DocumentTarget | undefined>;
	/** Jev, when configured; otherwise, or when it fails, the heuristic decides. */
	ask?: ReadinessAsk;
	/** Called after a document's judgement changes. */
	changed?: (channelId: string, revision: number, ready: boolean) => void;
	debounceMs?: number;
	after?: (delayMs: number, action: () => void) => () => void;
	error?: (err: unknown) => void;
	/** Documents already past readiness (living, built, or implemented) are never judged. */
	skip?: (channelId: string) => boolean;
	/** Most judgements kept in memory. */
	limit?: number;
};

const QUESTION =
	"Is this document a complete enough plan that a coding agent could build a first version now?";
/** Jev state is bounded; the opening of a long document carries the judgement. */
const SOURCE_LIMIT = 20_000;

/** Enough prose and structure to be worth building, for when Jev cannot say. */
export function looksBuildable(source: string): boolean {
	let lines = source.split("\n");
	let headings = lines.filter(line => /^#{1,6}\s+\S/.test(line)).length;
	let words = source.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)?.length ?? 0;
	return words >= 120 && headings >= 2;
}

export async function judgeBuildable(
	source: string,
	ask?: ReadinessAsk,
	error?: (err: unknown) => void,
): Promise<boolean> {
	if (!ask) return looksBuildable(source);
	try {
		let result = await ask({
			state: { document: source.slice(0, SOURCE_LIMIT) },
			questions: {
				build_ready: {
					type: "noul",
					instructions: QUESTION,
					criteria: {
						true:
							"The document states what to build and enough of how for a first working version.",
						false: "The document is a sketch, a list of open questions, or too thin to build from.",
					},
				},
			},
		});
		let answer = result.answers.build_ready;
		if (answer?.type !== "noul") throw new Error("invalid Jev readiness answer");
		return answer.noul >= 0.5;
	} catch (err) {
		error?.(err);
		return looksBuildable(source);
	}
}

/**
 * Whether each document reads as ready to build, judged once its edits settle.
 *
 * In memory only: a restart forgets every judgement and the next read asks again.
 */
export class BuildReadiness {
	#options: ReadinessOptions;
	#debounceMs: number;
	#judged = new Map<string, { revision: number; ready: boolean }>();
	#pending = new Map<string, () => void>();
	#running = new Map<string, Promise<void>>();
	#dirty = new Set<string>();
	#closed = false;

	constructor(options: ReadinessOptions) {
		this.#options = options;
		this.#debounceMs = options.debounceMs ?? 10_000;
	}

	/**
	 * The latest judgement, or `false` before the first. A stale one stands until
	 * its successor arrives, so a small edit does not hide a ready document.
	 */
	ready(channelId: string, revision: number): boolean {
		if (this.#options.skip?.(channelId)) return false;
		let judged = this.#judged.get(channelId);
		if (judged) {
			this.#judged.delete(channelId);
			this.#judged.set(channelId, judged);
		}
		if (judged?.revision !== revision && !this.#pending.has(channelId)) {
			void this.#judge(channelId);
		}
		return judged?.ready ?? false;
	}

	/** A committed edit: judge again once edits stop for the debounce window. */
	schedule(target: DocumentTarget): void {
		if (this.#closed || this.#options.skip?.(target.channelId)) return;
		this.#pending.get(target.channelId)?.();
		let after = this.#options.after ?? ((delay, action) => {
			let timer = setTimeout(action, delay);
			return () => clearTimeout(timer);
		});
		let cancel = after(this.#debounceMs, () => {
			if (this.#pending.get(target.channelId) !== cancel) return;
			this.#pending.delete(target.channelId);
			void this.#judge(target.channelId);
		});
		this.#pending.set(target.channelId, cancel);
	}

	/** Judge the document as it stands now; concurrent calls share one judgement. */
	#judge(channelId: string): Promise<void> {
		let running = this.#running.get(channelId);
		if (running) {
			this.#dirty.add(channelId);
			return running;
		}
		let work = (async () => {
			let again = false;
			try {
				this.#dirty.delete(channelId);
				let target = await this.#options.current(channelId);
				if (!target || this.#closed) return;
				let ready = await judgeBuildable(target.source, this.#options.ask, this.#options.error);
				if (this.#closed) return;
				let previous = this.#judged.get(channelId);
				if (previous && previous.revision > target.revision) return;
				this.#judged.delete(channelId);
				this.#judged.set(channelId, { revision: target.revision, ready });
				for (let key of this.#judged.keys()) {
					if (this.#judged.size <= (this.#options.limit ?? 500)) break;
					this.#judged.delete(key);
				}
				again = this.#dirty.has(channelId);
				if (previous?.ready !== ready) this.#options.changed?.(channelId, target.revision, ready);
			} catch (err) {
				this.#options.error?.(err);
			} finally {
				this.#running.delete(channelId);
				if (again && !this.#closed) void this.#judge(channelId);
			}
		})();
		this.#running.set(channelId, work);
		return work;
	}

	forget(channelId: string): void {
		this.#pending.get(channelId)?.();
		this.#pending.delete(channelId);
		this.#judged.delete(channelId);
		this.#dirty.delete(channelId);
	}

	close(): void {
		this.#closed = true;
		for (let cancel of this.#pending.values()) cancel();
		this.#pending.clear();
	}
}
