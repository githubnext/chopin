import {
	changeFollowthrough,
	followthroughLimit,
	followthroughPublication,
} from "../followthrough";
import type {
	Followthrough,
	FollowthroughChange,
	FollowthroughContext,
	FollowthroughKind,
	FollowthroughPublication,
	FollowthroughStore,
} from "../followthrough";
import type { Lease } from "../model";

export class MemoryFollowthroughStore implements FollowthroughStore {
	#records = new Map<string, Followthrough>();
	constructor(
		private exists: (id: string) => boolean,
		private fence: (lease: Lease) => void,
		private eligible: (channelId: string, childId: string) => boolean,
	) {}
	/** Validate before channel publication, then commit synchronously after it cannot fail. */
	prepare(input: FollowthroughPublication): () => void {
		let value = followthroughPublication(input);
		return () => {
			if (!this.#records.has(value.id)) this.#records.set(value.id, value);
		};
	}
	deleteChannel(id: string): void {
		for (let [key, value] of this.#records) {
			if (value.channelId === id || value.childId === id) this.#records.delete(key);
		}
	}
	async get(channelId: string, id: string) {
		let value = this.#records.get(id);
		return value?.channelId === channelId && this.exists(channelId) && this.exists(value.childId)
			? structuredClone(value)
			: undefined;
	}
	async forSource(channelId: string, kind: FollowthroughKind, sourceId: string) {
		return this.#values().filter(value =>
			value.channelId === channelId && value.kind === kind && value.sourceId === sourceId
		).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id))
			.slice(0, 100).map(value => structuredClone(value));
	}
	async pending(channelId: string | undefined, limit: number) {
		let count = followthroughLimit(limit);
		return this.#values().filter(value =>
			value.status === "pending" && (channelId === undefined || value.channelId === channelId)
		)
			.sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime() || a.id.localeCompare(b.id))
			.slice(0, count).map(value => structuredClone(value));
	}
	claim(
		channelId: string,
		id: string,
		revision: number,
		context: FollowthroughContext,
		lease: Lease,
	) {
		return this.#change(channelId, id, revision, { action: "claim", context }, lease);
	}
	defer(channelId: string, id: string, revision: number, reason: string, lease: Lease) {
		return this.#change(channelId, id, revision, { action: "defer", reason }, lease);
	}
	finish(
		channelId: string,
		id: string,
		revision: number,
		outcome: "done" | "failed" | "skipped",
		reason: string | undefined,
		lease: Lease,
	) {
		return this.#change(channelId, id, revision, { action: "finish", outcome, reason }, lease);
	}
	retry(channelId: string, id: string, revision: number, lease: Lease) {
		return this.#change(channelId, id, revision, { action: "retry" }, lease);
	}
	dismiss(channelId: string, id: string, revision: number, lease: Lease) {
		return this.#change(channelId, id, revision, { action: "dismiss" }, lease);
	}
	skip(channelId: string, id: string, revision: number, reason: string, lease: Lease) {
		return this.#change(channelId, id, revision, { action: "skip", reason }, lease);
	}
	releaseUnstarted(
		channelId: string,
		id: string,
		revision: number,
		attemptToken: string,
		reason: string,
		lease: Lease,
	) {
		return this.#change(channelId, id, revision, {
			action: "release-unstarted",
			attemptToken,
			reason,
		}, lease);
	}
	async recoverInterrupted(lease: Lease) {
		this.fence(lease);
		let count = 0;
		for (let value of this.#values()) {
			if (value.status !== "running") continue;
			this.#records.set(
				value.id,
				changeFollowthrough(value, {
					action: "finish",
					outcome: "failed",
					reason: "interrupted",
				})!,
			);
			count++;
		}
		return count;
	}
	#values() {
		return [...this.#records.values()].filter(value =>
			this.exists(value.channelId) && this.exists(value.childId)
		);
	}
	async #change(
		channelId: string,
		id: string,
		revision: number,
		change: FollowthroughChange,
		lease: Lease,
	) {
		this.fence(lease);
		let value = this.#records.get(id);
		if (
			!value || value.channelId !== channelId || !this.exists(channelId)
			|| !this.exists(value.childId)
			|| value.revision !== revision
		) return;
		if (change.action === "claim" && !this.eligible(channelId, value.childId)) return;
		let next = changeFollowthrough(value, change);
		if (!next) return;
		this.#records.set(id, next);
		return structuredClone(next);
	}
}
