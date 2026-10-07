import { expect, test } from "bun:test";
import { attachRun, begin, finish, initialState, observe, registerProposal } from "./state.mjs";

let observation = { number: 12, head: "head", baseHead: "base", action: "repair" };
let failed = { kind: "failed", fingerprint: "ci:types", progress: false };

function attempt(state, id, outcome = failed, now = 0) {
	return finish(begin(state, id, now), id, outcome, now);
}

test("duplicate observation retains unresolved dispatch intent and rejects competing writers", () => {
	let state = begin(initialState(observation, 0), "a", 1);
	let duplicate = observe(state, observation, { now: 2 });
	expect(duplicate.active).toEqual(state.active);
	expect(() => begin(duplicate, "b", 2)).toThrow();
	let attached = attachRun(duplicate, "a", "run-1");
	expect(attachRun(attached, "a", "run-1")).toEqual(attached);
	expect(() => attachRun(attached, "a", "run-2")).toThrow();
});

test("human change resets episode while old attempt cannot charge or release a newer one", () => {
	let state = begin(initialState(observation, 0), "old", 1);
	let fresh = observe(state, { ...observation, head: "human" }, { now: 2, humanChange: true });
	expect(fresh.episode).toBe(state.episode + 1);
	expect(fresh.active?.id).toBe("old");
	fresh = finish(fresh, "old", failed, 3);
	expect(fresh.repairCount).toBe(0);
	fresh = begin(fresh, "new", 4);
	expect(finish(fresh, "old", failed, 5)).toEqual(fresh);
});

test("human blocker survives base movement and automation head changes until trusted resolution", () => {
	let state = attempt(initialState(observation, 0), "a", { kind: "blocked", reason: "intent" });
	let changed = observe(state, {
		...observation,
		head: "bot",
		baseHead: "new-base",
		action: "ready",
	}, { now: 1 });
	expect(changed.blocker).toEqual(state.blocker);
	expect(changed.status).toBe("blocked");
	expect(() => begin(changed, "b", 1)).toThrow();
	let resolved = observe(changed, observation, { now: 2, resolved: true });
	expect(resolved.blocker).toBeNull();
	expect(resolved.episode).toBe(state.episode);
});

test("two same failures without progress escalate, progress interrupts the streak", () => {
	let state = attempt(initialState(observation, 0), "a");
	state = attempt(state, "b");
	expect(state.status).toBe("blocked");
	expect(state.repairCount).toBe(2);
	state = observe(state, observation, { now: 1, authenticatedRetry: true });
	state = attempt(state, "c");
	state = attempt(state, "d", { ...failed, progress: true });
	expect(state.blocker).toBeNull();
	state = attempt(state, "e", { ...failed, fingerprint: "other" });
	expect(state.repairCount).toBe(3);
	expect(state.status).toBe("blocked");
});

test("applied repairs consume budget and await CI; rebase does not consume repair budget", () => {
	let state = attempt(initialState(observation, 0), "a", { kind: "applied", head: "fixed" });
	expect(state.status).toBe("waiting-ci");
	expect(state.head).toBe("fixed");
	expect(state.repairCount).toBe(1);
	state = observe(state, { ...observation, head: "fixed", action: "rebase" }, { now: 1 });
	state = attempt(state, "b", { kind: "applied", head: "rebased" }, 2);
	expect(state.repairCount).toBe(1);
	expect(state.status).toBe("waiting-ci");
	state = observe(state, { ...observation, head: "rebased", action: "ready" }, { now: 3 });
	expect(state.status).toBe("ready");
});

test("transients retry after 5, 15, 60 minutes then expose exhaustion without repair charges", () => {
	let state = initialState(observation, 0);
	let now = 0;
	for (let [index, delay] of [5, 15, 60].entries()) {
		state = attempt(state, `t${index}`, { kind: "transient", reason: "network" }, now);
		expect(state.nextRetryAt).toBe(now + delay * 60_000);
		expect(() => begin(state, "early", now)).toThrow();
		now = state.nextRetryAt;
	}
	state = attempt(state, "exhausted", { kind: "transient", reason: "network" }, now);
	expect(state.status).toBe("blocked");
	expect(state.repairCount).toBe(0);
});

test("unrelated changed head invalidates old result, superseded does not consume attempts", () => {
	for (let update of [{ head: "new" }]) {
		let state = begin(initialState(observation, 0), "a", 1);
		state = observe(state, { ...observation, ...update }, { now: 2 });
		state = finish(state, "a", { kind: "applied", head: "obsolete" }, 3);
		expect(state.head).toBe(update.head ?? observation.head);
		expect(state.repairCount).toBe(0);
		expect(state.active).toBeNull();
	}
	let state = attempt(initialState(observation, 0), "a", { kind: "superseded" });
	expect(state.repairCount).toBe(0);
});

test("transitions preserve deeply frozen inputs", () => {
	let state = Object.freeze(initialState(Object.freeze(observation), 0));
	let active = begin(state, "a", 1);
	Object.freeze(active.active);
	Object.freeze(active);
	let attached = attachRun(active, "a", "run");
	finish(attached, "a", failed, 2);
	expect(state.active).toBeNull();
	expect(active.active.runId).toBeNull();
});

test("invalid decisions, identifiers and timestamps fail explicitly", () => {
	expect(() => initialState({ ...observation, action: "guess" }, 0)).toThrow();
	expect(() => initialState({ ...observation, surprise: true }, 0)).toThrow();
	for (let now of [NaN, Infinity, -1]) expect(() => initialState(observation, now)).toThrow();
	let state = initialState(observation, 0);
	expect(() => begin(state, "", 0)).toThrow();
	expect(() => observe(state, observation, { now: 1, retry: true })).toThrow();
	state = begin(state, "a", 1);
	expect(() => attachRun(state, "a", "")).toThrow();
	expect(() => finish(state, "a", { kind: "guess" }, 2)).toThrow();
	expect(() => finish(state, "a", { ...failed, extra: true }, 2)).toThrow();
});

test("malformed persisted state is rejected before a transition", () => {
	let state = initialState(observation, 0);
	for (
		let corrupt of [
			{ repairCount: NaN },
			{ repairCount: -1 },
			{ repairCount: 4 },
			{ episode: 0 },
			{ failureCount: 1.5 },
			{ transientCount: Infinity },
			{ status: "guess" },
			{ nextRetryAt: NaN },
			{ unexpected: true },
			{ blocker: { id: "a", kind: "guess", reason: "oops" } },
			{ active: { id: "a" } },
		]
	) {
		let invalid = { ...state, ...corrupt };
		expect(() => observe(invalid, observation, { now: 1 })).toThrow();
		expect(() => begin(invalid, "a", 1)).toThrow();
		expect(() => attachRun(invalid, "a", "run")).toThrow();
		expect(() => finish(invalid, "a", failed, 1)).toThrow();
	}
	let missing = { ...state };
	delete missing.repairCount;
	expect(() => begin(missing, "a", 1)).toThrow();
	let active = begin(state, "a", 1);
	expect(() => finish({ ...active, active: { ...active.active, episode: 99 } }, "a", failed, 2))
		.toThrow();
});

test("three applied repairs visibly block further repair but allow successful CI readiness", () => {
	let state = initialState(observation, 0);
	for (let index of [1, 2, 3]) {
		state = attempt(state, `a${index}`, { kind: "applied", head: `fixed${index}` }, index);
		expect(state.status).toBe("waiting-ci");
		if (index < 3) state = observe(state, { ...observation, head: state.head }, { now: index });
	}
	let ready = observe(state, { ...observation, head: state.head, action: "ready" }, { now: 4 });
	expect(ready.status).toBe("ready");
	for (let action of ["repair", "conflict"]) {
		let exhausted = observe(state, { ...observation, head: state.head, action }, { now: 4 });
		expect(exhausted.status).toBe("blocked");
		expect(exhausted.blocker.reason).toBe("Repair budget exhausted");
	}
});

test("published proposal observations and base movement retain same-episode repair accounting", () => {
	for (
		let update of [{ head: "published" }, { baseHead: "new-base" }, {
			head: "published",
			baseHead: "new-base",
		}]
	) {
		let state = begin(initialState(observation, 0), "a", 1);
		state = observe(state, { ...observation, ...update }, { now: 2 });
		state = finish(state, "a", { kind: "applied", head: "published" }, 3);
		expect(state.repairCount).toBe(1);
		expect(state.head).toBe("published");
		expect(state.baseHead).toBe(update.baseHead ?? observation.baseHead);
		expect(state.status).toBe("waiting-ci");
	}
});

test("a base change charges a completed failed repair without reusing its stale failure signal", () => {
	let state = attempt(initialState(observation, 0), "first");
	state = begin(state, "second", 1);
	state = observe(state, { ...observation, baseHead: "new-base" }, { now: 2 });
	state = finish(state, "second", failed, 3);
	expect(state.repairCount).toBe(2);
	expect(state.blocker).toBeNull();
	expect(state.failureCount).toBe(1);
});

test("proposal registration retains immutable apply identity and rejects conflicting proposals", () => {
	let state = begin(initialState(observation, 0), "a", 1);
	Object.freeze(state.active);
	Object.freeze(state);
	let registered = registerProposal(state, "a", "proposed");
	expect(state.active.proposalHead).toBeNull();
	expect(registered.active.proposalHead).toBe("proposed");
	expect(registerProposal(registered, "a", "proposed")).toEqual(registered);
	expect(() => registerProposal(registered, "a", "other")).toThrow();
	expect(() => registerProposal(registered, "old", "proposed")).toThrow();
	expect(() => finish(registered, "a", { kind: "applied", head: "other" }, 2)).toThrow();
	let published = observe(registered, { ...observation, head: "proposed" }, { now: 2 });
	expect(finish(published, "a", { kind: "applied", head: "proposed" }, 3).repairCount).toBe(1);
});

test("dispatch age changes only when beginning work and survives observation and episode resets", () => {
	let state = initialState(observation, 7);
	expect(state.lastAttemptAt).toBe(0);
	state = begin(state, "a", 10);
	expect(state.lastAttemptAt).toBe(10);
	state = finish(state, "a", { kind: "transient", reason: "network" }, 20);
	state = observe(state, { ...observation, baseHead: "new-base" }, { now: 30 });
	expect(state.lastAttemptAt).toBe(10);
	state = observe(state, observation, { now: 40, humanChange: true });
	expect(state.lastAttemptAt).toBe(10);
	state = observe(state, observation, { now: 50, authenticatedRetry: true });
	expect(state.lastAttemptAt).toBe(10);
	state = begin(state, "b", 60);
	expect(state.lastAttemptAt).toBe(60);
	state = finish(state, "b", failed, 70);
	expect(state.lastAttemptAt).toBe(60);
	expect(() => begin({ ...state, lastAttemptAt: NaN }, "c", 80)).toThrow();
});

test("active action freezes dispatch mode independently of later observed actions", () => {
	for (let action of ["repair", "conflict", "rebase"]) {
		let state = begin(initialState({ ...observation, action }, 0), "a", 1);
		expect(state.active.action).toBe(action);
		expect(state.active.operation).toBe(action === "rebase" ? "rebase" : "repair");
		let changed = observe(state, { ...observation, action: "ready" }, { now: 2 });
		expect(changed.active.action).toBe(action);
		let invalid = { ...state, active: { ...state.active, action: "ready" } };
		expect(() => attachRun(invalid, "a", "run")).toThrow();
		invalid = {
			...state,
			active: { ...state.active, operation: action === "rebase" ? "repair" : "rebase" },
		};
		expect(() => attachRun(invalid, "a", "run")).toThrow();
	}
});
