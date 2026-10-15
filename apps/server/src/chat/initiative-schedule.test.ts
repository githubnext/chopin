import { expect, test } from "bun:test";
import {
	createInitiativeSchedule,
	type InitiativeClock,
	type InitiativeSchedule,
	type TurnContext,
	type TurnDecision,
	TYPING_LEASE_MS,
} from "./initiative-schedule";

type Timer = { at: number; callback: () => void };
type DispatchLifecycle = { started(): void; current(): boolean };

class ManualClock implements InitiativeClock {
	private time = 0;
	private nextId = 0;
	private timers = new Map<number, Timer>();

	now(): number {
		return this.time;
	}

	set(callback: () => void, delay: number): unknown {
		let id = ++this.nextId;
		this.timers.set(id, { at: this.time + delay, callback });
		return id;
	}

	clear(timer: unknown): void {
		if (typeof timer === "number") this.timers.delete(timer);
	}

	async advance(milliseconds: number): Promise<void> {
		let target = this.time + milliseconds;
		for (;;) {
			let next = [...this.timers.entries()]
				.filter(([, timer]) => timer.at <= target)
				.sort((left, right) => left[1].at - right[1].at)[0];
			if (!next) break;
			let [id, timer] = next;
			this.timers.delete(id);
			this.time = timer.at;
			timer.callback();
			await settlePromises();
		}
		this.time = target;
		await settlePromises();
	}

	get pendingTimers(): number {
		return this.timers.size;
	}
}

async function settlePromises(): Promise<void> {
	for (let i = 0; i < 12; i++) await Promise.resolve();
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	let promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function setup(overrides: {
	soloMs?: number;
	groupMs?: number;
	admit?: (value: string) => "ready" | "wait" | "drop";
	judge?: (value: string, signal: AbortSignal, turn: TurnContext) => Promise<TurnDecision>;
	dispatch?: (
		value: string,
		move: string,
		signal: AbortSignal,
		lifecycle: DispatchLifecycle,
	) => Promise<boolean>;
} = {}) {
	let clock = new ManualClock();
	let admissions: string[] = [];
	let judgments: string[] = [];
	let judgmentSignals: AbortSignal[] = [];
	let dispatches: string[] = [];
	let dispatchSignals: AbortSignal[] = [];
	let dispatchLifecycles: DispatchLifecycle[] = [];
	let schedule: InitiativeSchedule<string> = createInitiativeSchedule<string>({
		clock,
		soloMs: overrides.soloMs,
		groupMs: overrides.groupMs,
		admit(value) {
			admissions.push(value);
			return overrides.admit?.(value) ?? "ready";
		},
		judge(value, signal, turn) {
			judgments.push(value);
			judgmentSignals.push(signal);
			return overrides.judge
				? overrides.judge(value, signal, turn)
				: Promise.resolve("respond");
		},
		dispatch(value, move, signal, lifecycle) {
			dispatches.push(`${value}:${move}`);
			dispatchSignals.push(signal);
			dispatchLifecycles.push(lifecycle);
			return overrides.dispatch
				? overrides.dispatch(value, move, signal, lifecycle)
				: dispatch(value, move, lifecycle);
		},
	});
	return {
		clock,
		schedule,
		admissions,
		judgments,
		judgmentSignals,
		dispatches,
		dispatchSignals,
		dispatchLifecycles,
	};
}

function dispatch(
	_value: string,
	_move: string,
	lifecycle: DispatchLifecycle,
): Promise<boolean> {
	lifecycle.started();
	return Promise.resolve(true);
}

function receive(
	h: ReturnType<typeof setup>,
	id: string,
	actor: string,
	value = id,
): void {
	h.schedule.receive({ id, actor, value });
}

test("group turn judgment can answer an invitation quickly or yield until quiet", async () => {
	let phases: TurnContext[] = [];
	let h = setup({
		soloMs: 10,
		groupMs: 40,
		judge: async (_value, _signal, turn) => {
			phases.push(turn);
			return turn.quiet ? "respond" : "yield";
		},
	});
	receive(h, "ana-message", "ana");
	await h.clock.advance(5);
	receive(h, "bo-message", "bo");
	await h.clock.advance(10);
	expect(phases).toEqual([{ group: true, quiet: false, paused: false }]);
	expect(h.dispatches).toEqual([]);
	await h.clock.advance(29);
	expect(phases).toHaveLength(1);
	await h.clock.advance(1);
	expect(phases[1]).toEqual({ group: true, quiet: true, paused: false });
	expect(h.dispatches).toEqual(["bo-message:respond"]);
});

test("a direct group request does not wait for group silence", async () => {
	let h = setup({ soloMs: 10, groupMs: 40, judge: async () => "direct" });
	receive(h, "ana-message", "ana");
	receive(h, "bo-message", "bo");
	await h.clock.advance(10);
	expect(h.dispatches).toEqual(["bo-message:direct"]);
});

test("replying clears earlier speakers so the next human gets a solo turn", async () => {
	let phases: TurnContext[] = [];
	let h = setup({
		soloMs: 10,
		judge: async (_value, _signal, turn) => {
			phases.push(turn);
			return "respond";
		},
	});
	receive(h, "ana-message", "ana");
	receive(h, "bo-message", "bo");
	await h.clock.advance(10);
	h.schedule.replied();
	receive(h, "ana-reply", "ana");
	await h.clock.advance(10);
	expect(phases.map(phase => phase.group)).toEqual([true, false]);
});

test("pause permits only a new direct request and never retries a yielded judgment", async () => {
	let h = setup({ soloMs: 10, judge: async value => value === "direct" ? "direct" : "respond" });
	h.schedule.pause(true);
	receive(h, "ordinary", "ana");
	await h.clock.advance(10);
	expect(h.dispatches).toEqual([]);
	receive(h, "direct", "ana");
	await h.clock.advance(10);
	expect(h.dispatches).toEqual(["direct:direct"]);
	await h.clock.advance(60_000);
	expect(h.dispatches).toHaveLength(1);
});

test("coalesces a burst into a judgment of only the latest message", async () => {
	let h = setup({ soloMs: 10 });
	receive(h, "first", "ana", "first message");
	await h.clock.advance(5);
	receive(h, "latest", "ana", "latest message");
	await h.clock.advance(9);
	expect(h.judgments).toEqual([]);
	await h.clock.advance(1);
	expect(h.judgments).toEqual(["latest message"]);
	expect(h.dispatches).toEqual(["latest message:respond"]);
});

test("typing leases extend silence and stopping typing starts a fresh quiet window", async () => {
	let lease = setup({ soloMs: 10 });
	receive(lease, "source", "ana");
	lease.schedule.typing("ana-tab", "ana", true);
	await lease.clock.advance(TYPING_LEASE_MS + 9);
	expect(lease.judgments).toEqual([]);
	await lease.clock.advance(1);
	expect(lease.judgments).toEqual(["source"]);

	let stopped = setup({ soloMs: 10 });
	receive(stopped, "source", "ana");
	stopped.schedule.typing("ana-tab", "ana", true);
	await stopped.clock.advance(5);
	stopped.schedule.typing("ana-tab", "ana", false);
	await stopped.clock.advance(9);
	expect(stopped.judgments).toEqual([]);
	await stopped.clock.advance(1);
	expect(stopped.judgments).toEqual(["source"]);
});

test("a newer message aborts a stale judgment before it can dispatch", async () => {
	let stale = deferred<TurnDecision>();
	let h = setup({
		soloMs: 10,
		groupMs: 10,
		judge: (value) => value === "old" ? stale.promise : Promise.resolve("respond"),
	});
	receive(h, "old-id", "ana", "old");
	await h.clock.advance(10);
	expect(h.judgments).toEqual(["old"]);
	receive(h, "new-id", "bo", "new");
	expect(h.judgmentSignals[0]?.aborted).toBe(true);
	stale.resolve("direct");
	await settlePromises();
	expect(h.dispatches).toEqual([]);
	await h.clock.advance(10);
	expect(h.judgments).toEqual(["old", "new"]);
	expect(h.dispatches).toEqual(["new:respond"]);
});

test("a new human message cancels a dispatch that has not started and gets a fresh judgment", async () => {
	let firstDispatch = deferred<boolean>();
	let h = setup({
		soloMs: 10,
		groupMs: 10,
		dispatch: (value, _move, _signal, lifecycle) => {
			if (value === "old") return firstDispatch.promise;
			lifecycle.started();
			return Promise.resolve(true);
		},
	});
	receive(h, "old-id", "ana", "old");
	await h.clock.advance(10);
	expect(h.dispatches).toEqual(["old:respond"]);
	receive(h, "new-id", "bo", "new");
	expect(h.dispatchSignals[0]?.aborted).toBe(true);
	firstDispatch.resolve(true);
	await settlePromises();
	await h.clock.advance(10);
	expect(h.judgments).toEqual(["old", "new"]);
	expect(h.dispatches).toEqual(["old:respond", "new:respond"]);
});

test("a stale judgment cannot clear a newer dispatch running on the same opportunity", async () => {
	let staleJudgment = deferred<TurnDecision>();
	let runningDispatch = deferred<boolean>();
	let judgmentCalls = 0;
	let h = setup({
		soloMs: 10,
		judge: async () => {
			judgmentCalls++;
			return judgmentCalls === 1 ? staleJudgment.promise : "respond";
		},
		dispatch: (_value, _move, _signal, lifecycle) => {
			lifecycle.started();
			return runningDispatch.promise;
		},
	});
	receive(h, "source", "ana");
	await h.clock.advance(10);
	h.schedule.typing("ana-tab", "ana", true);
	expect(h.judgmentSignals[0]?.aborted).toBe(true);
	await h.clock.advance(TYPING_LEASE_MS + 10);
	expect(h.judgments).toEqual(["source", "source"]);
	expect(h.dispatchLifecycles[0]?.current()).toBe(true);

	staleJudgment.resolve("direct");
	await settlePromises();
	h.schedule.typing("bo-tab", "bo", true);
	expect(h.dispatchSignals[0]?.aborted).toBe(false);
	runningDispatch.resolve(true);
	await settlePromises();
});

test("typing before dispatch starts invalidates it, while typing after start leaves it running", async () => {
	let waitingDispatch = deferred<boolean>();
	let runningDispatch = deferred<boolean>();
	let dispatchCount = 0;
	let h = setup({
		soloMs: 10,
		dispatch: (_value, _move, _signal, lifecycle) => {
			dispatchCount++;
			if (dispatchCount === 1) return waitingDispatch.promise;
			lifecycle.started();
			return runningDispatch.promise;
		},
	});
	receive(h, "source", "ana");
	await h.clock.advance(10);
	let beforeStart = h.dispatchLifecycles[0]!;
	expect(beforeStart.current()).toBe(true);
	h.schedule.typing("ana-tab", "ana", true);
	expect(h.dispatchSignals[0]?.aborted).toBe(true);
	expect(beforeStart.current()).toBe(false);
	waitingDispatch.resolve(false);
	await settlePromises();
	h.schedule.typing("ana-tab", "ana", false);
	await h.clock.advance(10);
	expect(h.judgments).toEqual(["source", "source"]);
	let afterStart = h.dispatchLifecycles[1]!;
	expect(afterStart.current()).toBe(true);
	h.schedule.typing("bo-tab", "bo", true);
	expect(h.dispatchSignals[1]?.aborted).toBe(false);
	runningDispatch.resolve(true);
	await settlePromises();
});

test("pause clears pending work and requires new input after resume", async () => {
	let h = setup({ soloMs: 10 });
	receive(h, "paused", "ana");
	h.schedule.pause(true);
	await h.clock.advance(100);
	expect(h.judgments).toEqual([]);
	h.schedule.pause(false);
	await h.clock.advance(100);
	expect(h.judgments).toEqual([]);
	receive(h, "fresh", "ana");
	await h.clock.advance(10);
	expect(h.judgments).toEqual(["fresh"]);
});

test("close aborts judgment, clears timers, and ignores future input", async () => {
	let judgment = deferred<TurnDecision>();
	let h = setup({ soloMs: 10, judge: () => judgment.promise });
	receive(h, "source", "ana");
	await h.clock.advance(10);
	h.schedule.close();
	expect(h.judgmentSignals[0]?.aborted).toBe(true);
	judgment.resolve("respond");
	await settlePromises();
	receive(h, "later", "bo");
	h.schedule.typing("bo-tab", "bo", true);
	await h.clock.advance(100);
	expect(h.judgments).toEqual(["source"]);
	expect(h.dispatches).toEqual([]);
	expect(h.clock.pendingTimers).toBe(0);
});

test("an opportunity expires after five minutes while admission remains busy", async () => {
	let ready = false;
	let h = setup({ soloMs: 10, admit: () => ready ? "ready" : "wait" });
	receive(h, "expired", "ana");
	await h.clock.advance(10);
	expect(h.judgments).toEqual([]);
	await h.clock.advance(5 * 60 * 1_000 - 10);
	expect(h.judgments).toEqual([]);
	expect(h.clock.pendingTimers).toBe(0);
	ready = true;
	receive(h, "fresh", "ana");
	await h.clock.advance(10);
	expect(h.judgments).toEqual(["fresh"]);
});

test("a judgment that finishes after five minutes cannot dispatch", async () => {
	let judgment = deferred<TurnDecision>();
	let h = setup({ soloMs: 10, judge: () => judgment.promise });
	receive(h, "expired", "ana");
	await h.clock.advance(10);
	await h.clock.advance(5 * 60 * 1_000 - 10);
	judgment.resolve("direct");
	await settlePromises();
	expect(h.dispatches).toEqual([]);
	await h.clock.advance(1);
	expect(h.clock.pendingTimers).toBe(0);
});

test("a no-move or failed judgment is consumed until a new source arrives", async () => {
	let noMove = setup({ soloMs: 10, judge: async () => undefined });
	receive(noMove, "quiet", "ana");
	await noMove.clock.advance(10);
	await noMove.clock.advance(60_000);
	expect(noMove.judgments).toEqual(["quiet"]);
	expect(noMove.dispatches).toEqual([]);

	let failed = setup({
		soloMs: 10,
		judge: async () => {
			throw new Error("offline");
		},
	});
	receive(failed, "failed", "ana");
	await failed.clock.advance(10);
	await failed.clock.advance(60_000);
	expect(failed.judgments).toEqual(["failed"]);
	expect(failed.dispatches).toEqual([]);
});

test("waits for turn admission, then judges against the newly available state", async () => {
	let ready = false;
	let h = setup({ soloMs: 10, admit: () => ready ? "ready" : "wait" });
	receive(h, "source", "ana");
	await h.clock.advance(10);
	expect(h.admissions).toEqual(["source"]);
	expect(h.judgments).toEqual([]);
	ready = true;
	await h.clock.advance(1_000);
	expect(h.admissions.length).toBeGreaterThan(1);
	expect(h.judgments).toEqual(["source"]);
	expect(h.dispatches).toEqual(["source:respond"]);
});

test("rechecks admission after judgment and discards a move when a turn starts meanwhile", async () => {
	let admissionCalls = 0;
	let h = setup({
		soloMs: 10,
		admit: () => ++admissionCalls === 2 ? "wait" : "ready",
		judge: async (_value, _signal) => admissionCalls === 1 ? "direct" : "respond",
	});
	receive(h, "source", "ana");
	await h.clock.advance(10);
	expect(h.judgments).toEqual(["source"]);
	expect(h.dispatches).toEqual([]);
	await h.clock.advance(1);
	await h.clock.advance(1_000);
	expect(h.judgments).toEqual(["source", "source"]);
	expect(h.dispatches).toEqual(["source:respond"]);
});

test("duplicate source IDs do not replace or restart an opportunity", async () => {
	let h = setup({ soloMs: 10 });
	receive(h, "same-source", "ana", "original");
	await h.clock.advance(5);
	receive(h, "same-source", "bo", "duplicate");
	await h.clock.advance(5);
	expect(h.judgments).toEqual(["original"]);
	receive(h, "same-source", "bo", "duplicate after completion");
	await h.clock.advance(60_000);
	expect(h.judgments).toEqual(["original"]);
	expect(h.dispatches).toEqual(["original:respond"]);
});
