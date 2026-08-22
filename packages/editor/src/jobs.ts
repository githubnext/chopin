import { useSyncExternalStore } from "react";

import type { Job, Session } from "@chopin/protocol";
import type { Transport, Unsubscribe } from "./transport";

export type JobView = Job.View;
export type JobDetail = Job.Detail;
export type JobPage = Job.List.Reply;

export type JobSnapshot = {
	revision: number;
	jobs: Job.View[];
	details: Readonly<Record<string, Job.Detail>>;
	ready: boolean;
	refreshing: boolean;
	truncated: boolean;
	error?: string;
	pending: Readonly<Record<string, "assign" | "cancel" | "detail">>;
};

const EMPTY: JobSnapshot = {
	revision: 0,
	jobs: [],
	details: {},
	ready: false,
	refreshing: false,
	truncated: false,
	pending: {},
};

export class JobStore {
	#snapshot = EMPTY;
	#listeners = new Set<() => void>();
	#wire?: Transport;
	#generation = 0;
	#refresh?: Promise<void>;
	#dirty = false;
	#details = new Map<string, Promise<Job.Detail | undefined>>();
	#assignmentIds = new Map<string, { key: string; id: string }>();

	get snapshot(): JobSnapshot {
		return this.#snapshot;
	}

	subscribe = (listener: () => void): () => void => {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	};

	listen(wire: Transport): Unsubscribe {
		let generation = ++this.#generation;
		this.#wire = wire;
		let off = [
			wire.on<Session.Hello>("session:hello", frame => {
				if (frame.backgroundJobs) void this.refresh();
			}),
			wire.on<Job.Changed>("job:changed", frame => {
				if (frame.revision <= this.#snapshot.revision && this.#snapshot.ready) return;
				this.#dirty = true;
				void this.refresh();
			}),
		];
		return () => {
			for (let unsubscribe of off) unsubscribe();
			if (this.#generation === generation) {
				this.#generation++;
				this.#wire = undefined;
			}
		};
	}

	refresh(): Promise<void> {
		if (this.#refresh) {
			this.#dirty = true;
			return this.#refresh;
		}
		let wire = this.#wire;
		let generation = this.#generation;
		if (!wire || wire.connected === false) return Promise.resolve();
		this.#set({ ...this.#snapshot, refreshing: true, error: undefined });
		return this.#refresh = (async () => {
			do {
				this.#dirty = false;
				try {
					let reply = await wire.ask<Job.List.Reply>("job:list");
					if (generation !== this.#generation || reply.revision < this.#snapshot.revision) continue;
					let details = { ...this.#snapshot.details };
					for (let job of reply.jobs) {
						let cached = details[job.id];
						if (cached && cached.job.revision < job.revision) delete details[job.id];
					}
					this.#set({
						revision: reply.revision,
						jobs: reply.jobs,
						details,
						ready: true,
						refreshing: false,
						truncated: reply.truncated,
						pending: this.#snapshot.pending,
					});
				} catch (err) {
					if (generation === this.#generation) {
						this.#set({
							...this.#snapshot,
							refreshing: false,
							error: err instanceof Error ? err.message : "Could not load background jobs.",
						});
					}
				}
			} while (this.#dirty && generation === this.#generation && wire.connected !== false);
		})().finally(() => {
			this.#refresh = undefined;
			if (this.#dirty && this.#wire?.connected !== false) void this.refresh();
		});
	}

	async assignResearch(questionId: string, requestKey = "initial"): Promise<Job.View> {
		let wire = this.#required();
		let remembered = this.#assignmentIds.get(questionId);
		let requestId = remembered?.key === requestKey ? remembered.id : crypto.randomUUID();
		this.#assignmentIds.set(questionId, { key: requestKey, id: requestId });
		this.#pending(questionId, "assign");
		try {
			let reply = await wire.ask<Job.Assign.Reply>("job:assign", {
				type: "research-question",
				questionId,
				requestId,
			});
			this.#upsert(reply.job);
			void this.refresh();
			return reply.job;
		} finally {
			this.#pending(questionId, undefined);
		}
	}

	async cancel(job: Job.View): Promise<Job.View> {
		let wire = this.#required();
		this.#pending(job.id, "cancel");
		try {
			let current = (await this.detail(job.id, true, false))?.job ?? job;
			this.#pending(job.id, "cancel");
			let reply = await wire.ask<Job.Cancel.Reply>("job:cancel", {
				id: job.id,
				expectedRevision: current.revision,
			});
			this.#upsert(reply.job);
			return reply.job;
		} finally {
			this.#pending(job.id, undefined);
			void this.refresh();
		}
	}

	detail(id: string, refresh = false, markPending = true): Promise<Job.Detail | undefined> {
		let cached = this.#snapshot.details[id];
		if (cached && !refresh) return Promise.resolve(cached);
		let existing = this.#details.get(id);
		if (existing) return existing;
		let wire = this.#required();
		if (markPending) this.#pending(id, "detail");
		let generation = this.#generation;
		let request = wire.ask<Job.Get.Reply>("job:get", { id }).then(reply => {
			if (generation !== this.#generation || !reply.detail) return reply.detail;
			let current = this.#snapshot.details[id];
			if (!current || current.job.revision <= reply.detail.job.revision) {
				this.#set({
					...this.#snapshot,
					details: { ...this.#snapshot.details, [id]: reply.detail },
				});
			}
			return reply.detail;
		}).finally(() => {
			this.#details.delete(id);
			if (markPending) this.#pending(id, undefined);
		});
		this.#details.set(id, request);
		return request;
	}

	#required(): Transport {
		if (!this.#wire || this.#wire.connected === false) throw new Error("not connected");
		return this.#wire;
	}

	#upsert(job: Job.View): void {
		let jobs = this.#snapshot.jobs.filter(value => value.id !== job.id);
		jobs.unshift(job);
		this.#set({ ...this.#snapshot, jobs });
	}

	#pending(key: string, value: JobSnapshot["pending"][string] | undefined): void {
		let pending = { ...this.#snapshot.pending };
		if (value) pending[key] = value;
		else delete pending[key];
		this.#set({ ...this.#snapshot, pending });
	}

	#set(snapshot: JobSnapshot): void {
		this.#snapshot = snapshot;
		for (let listener of this.#listeners) listener();
	}
}

export function useJobs(store: JobStore): JobSnapshot {
	return useSyncExternalStore(store.subscribe, () => store.snapshot, () => store.snapshot);
}

export function currentJobs(jobs: Job.View[]): Job.View[] {
	let current = new Map<string, Job.View>();
	for (let job of jobs) {
		let previous = current.get(job.targetKey);
		if (!previous || previous.targetGeneration < job.targetGeneration) {
			current.set(job.targetKey, job);
		}
	}
	return [...current.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function researchJob(jobs: Job.View[], questionId: string): Job.View | undefined {
	return currentJobs(jobs).find(job =>
		job.type === "research-question" && job.targetKey === `research-question:${questionId}`
	);
}

export function aggregateJobs(jobs: Job.View[]) {
	let current = currentJobs(jobs);
	return {
		active: current.filter(job => job.state === "pending" || job.state === "running").length,
		paused: current.filter(job => job.state === "paused").length,
		failed: current.filter(job => job.state === "failed").length,
		ready: current.filter(job => job.state === "completed").length,
	};
}

export function canCancelJob(job: Job.View): boolean {
	return job.type === "research-question"
		&& job.origin === "user"
		&& (job.state === "pending" || job.state === "paused" || job.state === "running");
}
