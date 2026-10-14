import type { Instruction, PreparedInstruction } from "../chat/service";
import type {
	Followthrough,
	FollowthroughContext,
	FollowthroughStore,
} from "../storage/followthrough";
import type { Lease } from "../storage/model";

export type ReviewScope =
	| { status: "ready"; context: FollowthroughContext; text: string }
	| { status: "deferred"; reason: string }
	| { status: "skipped"; reason: string };

type Options = {
	store: FollowthroughStore;
	lease: () => Lease;
	/** Re-read result identity, the current document and capability immediately before claiming. */
	inspect: (receipt: Followthrough) => Promise<ReviewScope>;
	/** Synchronous check immediately before invoking the model, after notice persistence. */
	blocked?: (receipt: Followthrough) => string | undefined;
	/** Uses the parent's existing owner and Chat queue. Never claims a new owner. */
	start: (receipt: Followthrough, instruction: Instruction) => Promise<true | string>;
	changed: (receipt: Followthrough) => void;
	error: (error: unknown) => void;
	clock?: () => number;
};

/** Durable result delivery; the in-memory gate covers pending Chat admission, not its receipt. */
export class FollowthroughCoordinator {
	#active = new Map<string, Promise<void>>();
	#deferredUntil = new Map<string, number>();
	#again = new Map<string, boolean>();
	#scheduled = new Map<string, ReturnType<typeof setTimeout>>();
	#closed = false;
	constructor(private options: Options) {}

	wake(channelId: string, retry = false): Promise<void> {
		if (this.#closed) return Promise.resolve();
		let active = this.#active.get(channelId);
		if (active) {
			this.#again.set(channelId, retry || this.#again.get(channelId) === true);
			return active;
		}
		let now = this.options.clock?.() ?? Date.now();
		let until = this.#deferredUntil.get(channelId) ?? 0;
		if (!retry && until > now) {
			if (!this.#scheduled.has(channelId)) {
				let timer = setTimeout(() => {
					this.#scheduled.delete(channelId);
					void this.wake(channelId);
				}, until - now);
				timer.unref();
				this.#scheduled.set(channelId, timer);
			}
			return Promise.resolve();
		}
		clearTimeout(this.#scheduled.get(channelId));
		this.#scheduled.delete(channelId);
		this.#deferredUntil.delete(channelId);
		// Schedule after installing the gate: opening a room itself wakes owner-bound work.
		let work = Promise.resolve().then(() => this.#drain(channelId)).catch(error => {
			this.#cooldown(channelId);
			this.options.error(error);
		}).finally(() => {
			this.#active.delete(channelId);
			let again = this.#again.get(channelId);
			this.#again.delete(channelId);
			if (again !== undefined) void this.wake(channelId, again);
		});
		this.#active.set(channelId, work);
		return work;
	}

	close(): void {
		this.#closed = true;
		this.#deferredUntil.clear();
		this.#again.clear();
		for (let timer of this.#scheduled.values()) clearTimeout(timer);
		this.#scheduled.clear();
	}

	#cooldown(channelId: string): void {
		// Session-open and queue-drain both announce owner availability. A refused attempt must
		// not immediately trigger itself through those callbacks. Fresh explicit retries bypass it.
		this.#deferredUntil.set(channelId, (this.options.clock?.() ?? Date.now()) + 30_000);
		if (this.#deferredUntil.size > 500) {
			this.#deferredUntil.delete(this.#deferredUntil.keys().next().value!);
		}
	}

	async #changed(value: Followthrough | undefined, before: Followthrough): Promise<void> {
		if (value && value.revision !== before.revision) this.options.changed(value);
	}

	async #defer(receipt: Followthrough, reason: string): Promise<void> {
		await this.#changed(
			await this.options.store.defer(
				receipt.channelId,
				receipt.id,
				receipt.revision,
				reason,
				this.options.lease(),
			),
			receipt,
		);
		this.#cooldown(receipt.channelId);
	}

	async #drain(channelId: string): Promise<void> {
		// One result at a time through the existing human/Planner queue. Source publication is
		// finite; terminal receipts never return here, even after reconnect or another read.
		while (!this.#closed) {
			let receipt = (await this.options.store.pending(channelId, 1))[0];
			if (!receipt) return;
			if (!await this.#deliver(receipt)) return;
		}
	}

	async #deliver(receipt: Followthrough): Promise<boolean> {
		let { store, lease } = this.options;
		let claimed: Followthrough | undefined;
		let safeToContinue = false;
		let finished = Promise.withResolvers<void>();
		let prepare = async (): Promise<PreparedInstruction> => {
			let current = await store.get(receipt.channelId, receipt.id);
			if (this.#closed || current?.status !== "pending") {
				safeToContinue = !this.#closed;
				return { status: "skipped" };
			}
			let scope = await this.options.inspect(current);
			if (scope.status === "deferred") {
				await this.#defer(current, scope.reason);
				return { status: "deferred" };
			}
			if (scope.status === "skipped") {
				await this.#changed(
					await store.skip(
						current.channelId,
						current.id,
						current.revision,
						scope.reason,
						lease(),
					),
					current,
				);
				safeToContinue = true;
				return { status: "skipped" };
			}
			claimed = await store.claim(
				current.channelId,
				current.id,
				current.revision,
				scope.context,
				lease(),
			);
			if (!claimed) return { status: "skipped" };
			this.options.changed(claimed);
			return {
				status: "ready",
				text: scope.text,
				noticeId: `followthrough:${claimed.id}:${claimed.attempts}`,
			};
		};
		let accepted = await this.options.start(receipt, {
			prepare,
			beforeStream: () => {
				if (!claimed) throw new Error("The result review has no durable claim.");
				let reason = this.options.blocked?.(claimed);
				if (!reason) return true;
				let attempt = claimed;
				return store.releaseUnstarted(
					attempt.channelId,
					attempt.id,
					attempt.revision,
					attempt.attemptToken!,
					reason,
					lease(),
				).then(saved => {
					if (!saved) throw new Error("The unstarted result review could not be deferred.");
					claimed = undefined;
					this.options.changed(saved);
					this.#cooldown(receipt.channelId);
					return false as const;
				});
			},
			// The same owner-bound permission used by readiness reviews can propose an
			// investigation or resolve its blocker; it cannot execute local work.
			readiness: true,
			ended: async outcome => {
				try {
					if (claimed) {
						let complete = outcome.status === "done" && !!outcome.text?.trim();
						let status: "done" | "failed" = complete ? "done" : "failed";
						let reason = complete
							? undefined
							: outcome.status === "done"
							? "review-incomplete"
							: outcome.status === "failed"
							? "review-failed"
							: "interrupted";
						let saved = await store.finish(
							claimed.channelId,
							claimed.id,
							claimed.revision,
							status,
							reason,
							lease(),
						);
						await this.#changed(saved, claimed);
						safeToContinue = !!saved;
					} else if (!safeToContinue) {
						let pending = await store.get(receipt.channelId, receipt.id);
						if (pending?.status === "pending" && !pending.reason) {
							await this.#defer(pending, "planner-unavailable");
						}
					}
				} finally {
					finished.resolve();
				}
			},
		});
		if (accepted !== true) {
			await this.#defer(receipt, accepted);
			return false;
		}
		await finished.promise;
		if (!safeToContinue) this.#cooldown(receipt.channelId);
		return safeToContinue;
	}
}
