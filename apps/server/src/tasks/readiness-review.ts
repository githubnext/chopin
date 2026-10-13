import type { Investigation } from "@chopin/experiment/records";
import type { Instruction } from "../chat/service";

type Evidence = Pick<Investigation, "id" | "revision" | "state" | "buildBlocker">;

/** One owner-bound review at a time, and one accepted attempt per completed evidence revision. */
export class ReadinessReviews {
	#running = new Set<string>();
	#attempted = new Map<string, string>();
	constructor(
		private options: {
			list: (channelId: string) => Promise<Evidence[]>;
			start: (channelId: string, about: Instruction) => Promise<boolean | "drop">;
		},
	) {}
	#key(values: Evidence[]): string {
		return values.filter(value => value.buildBlocker && value.state === "completed")
			.map(value => `${value.id}:${value.revision}`).sort().join("|");
	}
	async review(channelId: string): Promise<boolean> {
		if (this.#running.has(channelId)) return false;
		this.#running.add(channelId);
		let finished!: () => void;
		let ended = new Promise<void>(resolve => {
			finished = resolve;
		});
		try {
			let key = this.#key(await this.options.list(channelId));
			let accepted = await this.options.start(channelId, {
				readiness: true,
				ended: () => finished(),
			});
			if (accepted !== true) return false;
			if (key) this.#attempted.set(channelId, key);
			for (let id of this.#attempted.keys()) {
				if (this.#attempted.size <= 500) break;
				this.#attempted.delete(id);
			}
			await ended;
			return true;
		} finally {
			this.#running.delete(channelId);
		}
	}
	async evidence(channelId: string): Promise<void> {
		let key = this.#key(await this.options.list(channelId));
		if (!key) {
			this.#attempted.delete(channelId);
			return;
		}
		if (this.#attempted.get(channelId) === key) return;
		await this.review(channelId);
	}
}
