import { parse } from "@chopin/dialect/parse";
import { serialize } from "@chopin/dialect/serialize";

import type { JevRequest, JevResult } from "../conversation-plan/jev";
import type { DocumentTarget } from "../plan/service";

export type ReadinessAsk = (request: JevRequest) => Promise<JevResult>;

export type ReadinessOptions = {
	current: (channelId: string) => Promise<DocumentTarget | undefined>;
	/** Jev, when configured; otherwise, or when it fails, no speculative review is needed. */
	ask?: ReadinessAsk;
	/** A negative signal asks the Planner to create visible blockers; it never disables Build. */
	review?: (channelId: string, revision: number) => Promise<boolean>;
	/** Called after a document's judgement changes. */
	changed?: (channelId: string, revision: number, ready: boolean) => void;
	debounceMs?: number;
	after?: (delayMs: number, action: () => void) => () => void;
	error?: (err: unknown) => void;
	/** Active work or existing decisions may defer assessment. */
	skip?: (channelId: string) => boolean;
	/** Most judgements kept in memory. */
	limit?: number;
};

const QUESTION =
	"Can a coding agent make useful implementation progress without a missing human decision or necessary investigation?";
/** Jev state is bounded; the opening of a long document carries the judgement. */
const SOURCE_LIMIT = 20_000;

/**
 * The document without its top-level callouts. Spike results arrive as callouts, and a verdict
 * that changed whenever one was inserted would make Build plan flicker.
 */
export function withoutCallouts(source: string): string {
	try {
		// Always reserialized, so a source with and without callouts compare equal.
		let root = parse(source);
		return serialize({
			...root,
			children: root.children.filter(node =>
				node.type !== "mdxJsxFlowElement" || node.name !== "Callout"
			),
		});
	} catch {
		return source;
	}
}

export async function judgeBuildable(
	source: string,
	ask?: ReadinessAsk,
	error?: (err: unknown) => void,
): Promise<boolean> {
	if (!ask) return true;
	try {
		let result = await ask({
			state: { document: source.slice(0, SOURCE_LIMIT) },
			questions: {
				build_ready: {
					type: "noul",
					instructions: QUESTION,
					criteria: {
						true:
							"There is an identifiable goal or change. The agent can choose routine details and start useful implementation, even with a short or informal brief.",
						false:
							"A specific missing human choice or unavailable evidence prevents any useful implementation. Do not require a complete specification, word count, headings, or optional exploration.",
					},
				},
			},
		});
		let answer = result.answers.build_ready;
		if (answer?.type !== "noul") throw new Error("invalid Jev readiness answer");
		return answer.noul >= 0.5;
	} catch (err) {
		error?.(err);
		return true;
	}
}

/**
 * Whether useful implementation may need a concrete decision or investigation.
 *
 * In memory only: a restart forgets every judgement and the next read asks again.
 */
export class BuildReadiness {
	#options: ReadinessOptions;
	#debounceMs: number;
	/** `key` hashes the judged source without callouts, so callout-only edits keep the verdict. */
	#judged = new Map<string, {
		revision: number;
		ready: boolean;
		key: bigint | number;
		reviewed?: boolean;
	}>();
	#pending = new Map<string, () => void>();
	#running = new Map<string, Promise<void>>();
	#dirty = new Set<string>();
	#closed = false;

	constructor(options: ReadinessOptions) {
		this.#options = options;
		this.#debounceMs = options.debounceMs ?? 10_000;
	}

	/**
	 * The latest assessment signal, never build authorization. Reads also schedule help.
	 */
	ready(channelId: string, revision: number): boolean {
		// Active work or visible decisions already explain what is happening.
		if (this.#options.skip?.(channelId)) return true;
		let judged = this.#judged.get(channelId);
		if (judged) {
			this.#judged.delete(channelId);
			this.#judged.set(channelId, judged);
		}
		if (
			(judged?.revision !== revision || judged?.ready === false
					&& this.#options.review && !judged.reviewed) && !this.#pending.has(channelId)
		) {
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
				let source = withoutCallouts(target.source);
				let key = Bun.hash(source);
				let known = this.#judged.get(channelId);
				let ready = known?.key === key
					? known.ready
					: await judgeBuildable(source, this.#options.ask, this.#options.error);
				if (this.#closed) return;
				let reviewed = known?.key === key && known.reviewed;
				if (!ready && !reviewed && this.#options.review) {
					reviewed = await this.#options.review(channelId, target.revision);
				}
				if (this.#closed) return;
				let previous = this.#judged.get(channelId);
				if (previous && previous.revision > target.revision) return;
				this.#judged.delete(channelId);
				this.#judged.set(channelId, { revision: target.revision, ready, key, reviewed });
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
