import { describe, expect, it } from "bun:test";

import { aggregateJobs, currentJobs, JobStore, researchJob } from "./jobs";

import type { Job, Session } from "@chopin/protocol";
import type { Transport } from "./transport";

function job(over: Partial<Job.View> = {}): Job.View {
	return {
		id: crypto.randomUUID(),
		type: "research-question",
		version: 1,
		origin: "user",
		targetKey: "research-question:question",
		targetGeneration: 1,
		state: "pending",
		revision: 1,
		attempts: 0,
		failures: 0,
		availableAt: "2026-08-21T12:00:00.000Z",
		progress: [],
		createdAt: "2026-08-21T12:00:00.000Z",
		updatedAt: "2026-08-21T12:00:00.000Z",
		...over,
	};
}

class FakeWire implements Transport {
	connected = true;
	listeners = new Map<string, Set<(frame: never) => void>>();
	requests: Array<{ kind: string; payload?: Record<string, unknown> }> = [];
	replies: unknown[] = [];

	on<T>(kind: string, handler: (frame: T) => void) {
		let listeners = this.listeners.get(kind) ?? new Set();
		this.listeners.set(kind, listeners);
		listeners.add(handler as (frame: never) => void);
		return () => listeners.delete(handler as (frame: never) => void);
	}

	send(): void {}

	ask<T>(kind: string, payload?: Record<string, unknown>): Promise<T> {
		this.requests.push({ kind, payload });
		return Promise.resolve(this.replies.shift() as T);
	}

	emit<T>(kind: string, frame: T): void {
		for (let listener of this.listeners.get(kind) ?? []) listener(frame as never);
	}
}

describe("background job store", () => {
	it("loads on hello and refreshes a newer invalidation", async () => {
		let store = new JobStore();
		let wire = new FakeWire();
		let first = job();
		let second = {
			...first,
			state: "running" as const,
			revision: 2,
			attempts: 1,
			progress: [{
				revision: 2,
				attempt: 1,
				stage: "public-web",
				label: "Public web research",
				state: "started" as const,
				createdAt: "2026-08-21T12:00:01.000Z",
			}],
		};
		wire.replies.push(
			{ kind: "job:list", revision: 1, jobs: [first], truncated: false },
			{ kind: "job:list", revision: 2, jobs: [second], truncated: false },
		);
		let off = store.listen(wire);
		wire.emit<Session.Hello>("session:hello", { backgroundJobs: true } as Session.Hello);
		await waitFor(() => store.snapshot.revision === 1);
		wire.emit<Job.Changed>("job:changed", { kind: "job:changed", ts: 0, revision: 2 });
		await waitFor(() => store.snapshot.revision === 2);
		expect(store.snapshot.jobs[0]?.state).toBe("running");
		expect(store.snapshot.jobs[0]?.progress[0]?.label).toBe("Public web research");
		expect(wire.requests.map(request => request.kind)).toEqual(["job:list", "job:list"]);
		off();
	});

	it("does not request hidden background state when jobs are disabled", async () => {
		let store = new JobStore();
		let wire = new FakeWire();
		store.listen(wire);
		wire.emit<Session.Hello>("session:hello", { backgroundJobs: false } as Session.Hello);
		await Bun.sleep(1);
		expect(wire.requests).toEqual([]);
		expect(store.snapshot.ready).toBe(false);
	});

	it("uses correlated asks for assignment, cancellation, and detail", async () => {
		let store = new JobStore();
		let wire = new FakeWire();
		let pending = job();
		let cancelled = { ...pending, state: "cancelled" as const, revision: 2 };
		wire.replies.push(
			{ kind: "job:assign", repeated: false, job: pending },
			{ kind: "job:list", revision: 1, jobs: [pending], truncated: false },
			{ kind: "job:get", detail: { revision: 1, currentTargetGeneration: 1, job: pending } },
			{ kind: "job:cancel", job: cancelled },
			{ kind: "job:list", revision: 2, jobs: [cancelled], truncated: false },
		);
		store.listen(wire);
		await store.assignResearch("question");
		await waitFor(() => !store.snapshot.refreshing);
		expect((await store.detail(pending.id))?.job.id).toBe(pending.id);
		await store.cancel(pending);
		await waitFor(() => store.snapshot.jobs[0]?.state === "cancelled");
		expect(wire.requests.map(request => request.kind)).toEqual([
			"job:assign",
			"job:list",
			"job:get",
			"job:cancel",
			"job:list",
		]);
	});

	it("selects only the newest generation for aggregate and inline state", () => {
		let old = job({ id: "old", targetGeneration: 1, state: "failed" });
		let current = job({ id: "new", targetGeneration: 2, state: "running" });
		let summary = job({
			id: "summary",
			type: "document-summary",
			targetKey: "document-summary:document",
			state: "completed",
			updatedAt: "2026-08-21T13:00:00.000Z",
		});
		expect(currentJobs([old, current, summary]).map(value => value.id)).toEqual(["summary", "new"]);
		expect(researchJob([old, current], "question")?.id).toBe("new");
		expect(aggregateJobs([old, current, summary])).toEqual({
			active: 1,
			paused: 0,
			failed: 0,
			ready: 1,
		});
	});
});

async function waitFor(check: () => boolean): Promise<void> {
	let deadline = Date.now() + 500;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("condition did not become true");
		await Bun.sleep(1);
	}
}
