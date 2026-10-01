import { expect, test } from "bun:test";

import { ConversationPlanStore } from "./store";

import type { ConversationPlan } from "@chopin/protocol";
import type { Wire } from "../wire";

function fixture() {
	let listeners = new Map<string, Set<(frame: unknown) => void>>();
	let wire = {
		on(
			kind: string,
			listener: (frame: unknown) => void,
		) {
			let group = listeners.get(kind) ?? new Set();
			group.add(listener);
			listeners.set(kind, group);
			return () => group.delete(listener);
		},
	} as unknown as Wire;
	let emit = (
		kind: "conversation-plan:snapshot" | "conversation-plan:changed",
		revision: number,
		jobs: ConversationPlan.Job[] = [],
	) => {
		let state: ConversationPlan.State = {
			schemaVersion: 1,
			revision,
			events: [],
			threads: [],
			queue: [],
			analysis: [],
		};
		for (let listener of listeners.get(kind) ?? []) {
			listener({ kind, state, ts: 0, ...(kind === "conversation-plan:snapshot" ? { jobs } : {}) });
		}
	};
	let emitJobs = (jobs: ConversationPlan.Job[]) => {
		for (let listener of listeners.get("conversation-plan:jobs") ?? []) {
			listener({ kind: "conversation-plan:jobs", jobs, ts: 0 });
		}
	};
	return { emit, emitJobs, wire };
}

test("a changed frame can precede a stale snapshot; jobs replace and reset with the connection", () => {
	let store = new ConversationPlanStore("room-a");
	expect(store.get()).toEqual({ enabled: false, jobs: [] });
	let first = fixture();
	let close = store.listen(first.wire);
	first.emit("conversation-plan:changed", 2);
	first.emit("conversation-plan:snapshot", 1);
	expect(store.get()).toMatchObject({ enabled: true, state: { revision: 2 } });
	expect(store.get().jobs).toEqual([]);
	close();
	expect(store.get()).toEqual({ enabled: false, jobs: [] });
	let second = fixture();
	let closeSecond = store.listen(second.wire);
	expect(store.get()).toEqual({ enabled: false, jobs: [] });
	first.emit("conversation-plan:changed", 3);
	expect(store.get()).toEqual({ enabled: false, jobs: [] });
	let job: ConversationPlan.Job = {
		id: "refine:card-1:event-1",
		kind: "refine",
		target: "card-1",
		trigger: "message-1",
		status: "pending",
		attempts: 1,
		at: "2026-09-25T10:00:00.000Z",
	};
	second.emit("conversation-plan:snapshot", 4, [job]);
	expect(store.get()).toMatchObject({ enabled: true, state: { revision: 4 } });
	expect(store.get().jobs).toEqual([job]);
	second.emitJobs([{ ...job, status: "done", output: "Updated the title." }]);
	expect(store.get().jobs).toMatchObject([{ id: job.id, status: "done" }]);
	closeSecond();
	expect(store.get()).toEqual({ enabled: false, jobs: [] });
});

test("reset advances connection generation before notifying observers without changing snapshots", () => {
	let store = new ConversationPlanStore("room-a");
	let observed: Array<{ generation: number; snapshot: ReturnType<typeof store.get> }> = [];
	expect(store.generation).toBe(0);
	let unsubscribe = store.subscribe(() => {
		observed.push({ generation: store.generation, snapshot: store.get() });
	});
	store.reset();
	store.reset();
	expect(observed).toEqual([
		{ generation: 1, snapshot: { enabled: false, jobs: [] } },
		{ generation: 2, snapshot: { enabled: false, jobs: [] } },
	]);
	unsubscribe();
});

test("a coalesced reconnect retains a fresh generation and ignores the detached connection", () => {
	let store = new ConversationPlanStore("room-a");
	let first = fixture();
	let closeFirst = store.listen(first.wire);
	first.emit("conversation-plan:snapshot", 10);
	let previousGeneration = store.generation;
	first.emit("conversation-plan:changed", 11);
	first.emitJobs([]);
	expect(store.generation).toBe(previousGeneration);
	closeFirst();
	let second = fixture();
	let closeSecond = store.listen(second.wire);
	second.emit("conversation-plan:snapshot", 50);
	let reconnectGeneration = store.generation;
	expect(reconnectGeneration).toBeGreaterThan(previousGeneration);
	expect(store.get()).toMatchObject({ enabled: true, state: { revision: 50 } });
	first.emit("conversation-plan:changed", 100);
	expect(store.get()).toMatchObject({ state: { revision: 50 } });
	expect(store.generation).toBe(reconnectGeneration);
	second.emit("conversation-plan:changed", 51);
	second.emitJobs([]);
	expect(store.generation).toBe(reconnectGeneration);
	closeSecond();
});
