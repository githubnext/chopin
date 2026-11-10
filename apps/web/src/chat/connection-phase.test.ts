import { expect, test } from "bun:test";

import {
	connectionSpeech,
	connectionStep,
	expireResumed,
	INITIAL_MEMORY,
	NOTHING_SPOKEN,
	plannerForBanner,
	RESUMED_MS,
	retryLayer,
} from "./connection-phase";
import { RETRY_AFTER_FAILURES } from "@chopin/editor";

import { plannerStatus, plannerWithheld } from "./planner-status";

import type { Session } from "@chopin/protocol";
import type { ConnectionFacts, ConnectionMemory, Spoken } from "./connection-phase";

const AT = "2026-11-04T18:29:00.000Z";

const WELL: ConnectionFacts = {
	socket: "up",
	failures: 0,
	retrying: undefined,
	synced: true,
	current: true,
	turn: undefined,
	messages: 12,
	planner: undefined,
};

function step(memory: ConnectionMemory, facts: Partial<ConnectionFacts>) {
	return connectionStep(memory, { ...WELL, ...facts });
}

/** Runs the facts in order and returns the last step. */
function run(...sequence: Array<Partial<ConnectionFacts>>) {
	let memory = INITIAL_MEMORY;
	let last = connectionStep(memory, WELL);
	for (let facts of sequence) {
		last = step(memory, facts);
		memory = last.memory;
	}
	return last;
}

test("a connection that was never lost shows nothing", () => {
	expect(step(INITIAL_MEMORY, {}).view).toEqual({ phase: "online" });
});

test("a lost socket reconnects, counting the attempt in flight", () => {
	let { view } = step(INITIAL_MEMORY, { socket: "lost", failures: 0 });
	expect(view).toMatchObject({ phase: "reconnecting", layer: "socket", attempt: 1 });
	expect(run({ socket: "lost", failures: 2 }).view).toMatchObject({
		phase: "reconnecting",
		attempt: 3,
	});
});

test("a socket whose automatic attempts keep failing is dropped, and Reconnect asks for the socket", () => {
	let { view } = step(INITIAL_MEMORY, { socket: "lost", failures: 4 });
	expect(view).toMatchObject({ phase: "dropped", layer: "socket", action: "reconnect" });
	expect(retryLayer(view)).toBe("socket");
});

test("Reconnect is offered once enough automatic attempts have failed, and kept after", () => {
	for (let failures of [0, RETRY_AFTER_FAILURES - 1]) {
		expect(step(INITIAL_MEMORY, { socket: "lost", failures }).view.phase).toBe("reconnecting");
	}
	for (let failures of [RETRY_AFTER_FAILURES, RETRY_AFTER_FAILURES + 20]) {
		expect(step(INITIAL_MEMORY, { socket: "lost", failures }).view).toMatchObject({
			phase: "dropped",
			action: "reconnect",
		});
	}
});

test("Reconnect shows the attempt it starts until that attempt fails", () => {
	let pressed = run({ socket: "lost", failures: 4, retrying: 4 });
	expect(pressed.view).toMatchObject({ phase: "reconnecting", layer: "socket", attempt: 5 });
	let failed = run(
		{ socket: "lost", failures: 4, retrying: 4 },
		{ socket: "lost", failures: 5, retrying: 4 },
	);
	expect(failed.view).toMatchObject({ phase: "dropped", action: "reconnect" });
});

test("a connection that returns says so, and what it kept going", () => {
	let { view } = run(
		{ socket: "lost", turn: "t1", messages: 12 },
		{ turn: "t1", messages: 15 },
	);
	expect(view).toEqual({
		phase: "resumed",
		text: "Back. The reply kept going.",
		caught: "3 new messages",
	});
});

test("a reply that finished while the connection was dropped says it finished", () => {
	let { view } = run(
		{ socket: "lost", failures: 5, turn: "t1", messages: 12 },
		{ turn: undefined, messages: 14 },
	);
	expect(view).toEqual({
		phase: "resumed",
		text: "Back. The reply finished while you were away.",
		caught: "2 new messages",
	});
});

test("a return with nothing running and nothing new says the work is in sync", () => {
	let { view } = run({ socket: "lost" }, { messages: 12 });
	expect(view).toEqual({
		phase: "resumed",
		text: "Back online.",
		caught: "Your changes are synced",
	});
});

test("one new message is not plural", () => {
	let { view } = run({ socket: "lost" }, { messages: 13 });
	expect(view).toMatchObject({ phase: "resumed", caught: "1 new message" });
});

test("a different reply running on return is a new reply, not the one that kept going", () => {
	let { view } = run({ socket: "lost", turn: "t1" }, { turn: "t2", messages: 13 });
	expect(view).toMatchObject({ text: "Back. The reply finished while you were away." });
});

test("until the document and transcript have caught up the socket still reads as reconnecting", () => {
	let waiting = run({ socket: "lost", messages: 12 }, { synced: false });
	expect(waiting.view).toMatchObject({ phase: "reconnecting", layer: "sync", text: "Catching up" });
	let transcript = run({ socket: "lost", messages: 12 }, { current: false });
	expect(transcript.view).toMatchObject({ phase: "reconnecting", layer: "sync" });
});

test("a document that has not synced yet is loading, not a connection", () => {
	expect(step(INITIAL_MEMORY, { synced: false, current: false }).view).toEqual({
		phase: "online",
	});
});

test("the resumed words go once their time is up, and not before", () => {
	let back = run({ socket: "lost" }, {});
	expect(back.view.phase).toBe("resumed");
	expect(RESUMED_MS).toBeGreaterThan(0);
	let gone = connectionStep(expireResumed(back.memory), WELL);
	expect(gone.view).toEqual({ phase: "online" });
	// Expiring when nothing is resumed changes nothing.
	expect(expireResumed(INITIAL_MEMORY)).toBe(INITIAL_MEMORY);
});

test("a new loss ends a resume and is itself shown", () => {
	let { view } = run({ socket: "lost" }, {}, { socket: "lost", failures: 1 });
	expect(view).toMatchObject({ phase: "reconnecting", layer: "socket", attempt: 2 });
});

test("the Planner's connection is told in a machine's words when the socket is up", () => {
	let away = plannerStatus({ state: "disconnected", login: "mona" }, "Build box");
	expect(step(INITIAL_MEMORY, { planner: away }).view).toMatchObject({
		phase: "dropped",
		layer: "planner",
		text: "Build box is offline. Your work is kept.",
	});
	let held = plannerStatus({ state: "held", login: "mona", until: AT }, "Build box");
	expect(step(INITIAL_MEMORY, { planner: held }).view).toMatchObject({
		phase: "dropped",
		layer: "planner",
	});
});

test("a machine being connected to reconnects", () => {
	let starting = plannerStatus({ state: "starting", login: "mona" }, "Build box");
	expect(step(INITIAL_MEMORY, { planner: starting }).view).toMatchObject({
		phase: "reconnecting",
		layer: "planner",
		text: "Connecting to Build box",
	});
});

test("a machine that cannot be connected to is dropped, says why and how often, and can be asked to try now", () => {
	let failing = plannerStatus({
		state: "starting",
		login: "mona",
		failure: { attempts: 3, reason: "exit 1", at: AT },
	}, "Build box");
	let { view } = step(INITIAL_MEMORY, { planner: failing });
	expect(view).toMatchObject({
		phase: "dropped",
		layer: "planner",
		action: "wake",
		text: "Can't connect to Build box.",
		detail: ["exit 1", expect.stringMatching(/^Tried 3 times/)],
		link: { label: "How to fix" },
	});
	expect(retryLayer(view)).toBe("planner");
});

test("no machine at all is dropped, with nothing to retry from here", () => {
	let none = plannerStatus({ state: "none" });
	let { view } = step(INITIAL_MEMORY, { planner: none });
	expect(view).toMatchObject({
		phase: "dropped",
		layer: "planner",
		text: "No machine is connected.",
	});
	expect(retryLayer(view)).toBeUndefined();
});

test("a machine button already carries no machine, so only the button's absence has the banner say it", () => {
	let none = plannerStatus({ state: "none" });
	let away = plannerStatus({ state: "disconnected", login: "mona" }, "Build box");
	expect(plannerForBanner(none, true)).toBeUndefined();
	expect(plannerForBanner(none, false)).toBe(none);
	expect(plannerForBanner(away, true)).toBe(away);
	expect(plannerForBanner(undefined, false)).toBeUndefined();
});

test("the socket is told before the Planner, and neither is told twice", () => {
	let away = plannerStatus({ state: "disconnected", login: "mona" }, "Build box");
	let { view } = step(INITIAL_MEMORY, { socket: "lost", planner: away });
	expect(view).toMatchObject({ phase: "reconnecting", layer: "socket" });
});

test("a Planner problem that outlasts the resume is told once the resume is gone", () => {
	let away = plannerStatus({ state: "disconnected", login: "mona" }, "Build box");
	let back = run({ socket: "lost" }, { planner: away });
	expect(back.view.phase).toBe("resumed");
	expect(step(expireResumed(back.memory), { planner: away }).view).toMatchObject({
		phase: "dropped",
		layer: "planner",
	});
});

test("the Planner's dropped link offers no Reconnect from here and says so truthfully", () => {
	let away = plannerStatus({ state: "disconnected", login: "mona" }, "Build box");
	let { view } = step(INITIAL_MEMORY, { planner: away });
	expect(retryLayer(view)).toBeUndefined();
});

test("a screen reader hears each phase once, and nothing as the banner goes", () => {
	let reconnecting = step(INITIAL_MEMORY, { socket: "lost", failures: 0 }).view;
	let again = step(INITIAL_MEMORY, { socket: "lost", failures: 1 }).view;
	let dropped = step(INITIAL_MEMORY, { socket: "lost", failures: 4 }).view;
	let first = connectionSpeech(NOTHING_SPOKEN, reconnecting)!;
	expect(first.said).toBe("Reconnecting. Your changes are kept.");
	// One more attempt is the same phase: nothing new to say.
	expect(connectionSpeech(first.spoken, again)).toBeUndefined();
	let second = connectionSpeech(first.spoken, dropped)!;
	expect(second.said).toBe(
		"You're offline. Your changes are kept and will sync when you reconnect.",
	);
	let back = run({ socket: "lost" }, {}).view;
	let resumed = connectionSpeech(second.spoken, back)!;
	expect(resumed.said).toBe("Back online. Your changes are synced");
	// The same words again are not said again.
	expect(connectionSpeech(resumed.spoken, back)).toBeUndefined();
	// Going away is silent: the resumed words already said it was over.
	expect(connectionSpeech(resumed.spoken, { phase: "online" })).toEqual({
		spoken: NOTHING_SPOKEN,
		said: "",
	});
	expect(connectionSpeech(NOTHING_SPOKEN, { phase: "online" })).toBeUndefined();
});

test("a Planner state that carried on through a loss is not said again, and a different one is said once", () => {
	let away = step(INITIAL_MEMORY, {
		planner: plannerStatus({ state: "disconnected", login: "mona" }, "Build box"),
	}).view;
	let said = connectionSpeech(NOTHING_SPOKEN, away)!;
	expect(said.said).toBe("Build box is offline. Your work is kept.");
	let lost = connectionSpeech(said.spoken, step(INITIAL_MEMORY, { socket: "lost" }).view)!;
	let back = connectionSpeech(lost.spoken, run({ socket: "lost" }, {}).view)!;
	// The loss is over and the same machine is still away: nothing more to say about it.
	expect(connectionSpeech(back.spoken, away)?.said ?? "").toBe("");
	let starting = step(INITIAL_MEMORY, {
		planner: plannerStatus({ state: "starting", login: "mona" }, "Build box"),
	}).view;
	expect(connectionSpeech(back.spoken, starting)?.said).toBe("Connecting to Build box");
});

test("a gap while the Planner's status is only withheld is not the banner going: the same state is not said again", () => {
	let view = step(INITIAL_MEMORY, {
		planner: plannerStatus({ state: "disconnected", login: "mona" }, "Build box"),
	}).view;
	let said = connectionSpeech(NOTHING_SPOKEN, view)!;
	// Withheld: the banner is empty for a moment, and what was said is kept.
	expect(connectionSpeech(said.spoken, { phase: "online" }, true)).toBeUndefined();
	expect(connectionSpeech(said.spoken, view)).toBeUndefined();
	// Gone for good, it is said again when it comes back.
	let gone = connectionSpeech(said.spoken, { phase: "online" })!;
	expect(gone.spoken).toBe(NOTHING_SPOKEN);
	expect(connectionSpeech(gone.spoken, view)?.said).toBe(said.said);
});

test("stepping with the same facts again changes nothing, so a caller may store the memory each render", () => {
	let first = step(INITIAL_MEMORY, { socket: "lost", failures: 1, turn: "t", messages: 5 });
	let again = connectionStep(first.memory, {
		...WELL,
		socket: "lost",
		failures: 2,
		turn: "t",
		messages: 5,
	});
	expect(again.memory).toBe(first.memory);
	let back = connectionStep(first.memory, { ...WELL, turn: "t", messages: 5 });
	expect(connectionStep(back.memory, { ...WELL, turn: "t", messages: 5 }).memory).toBe(back.memory);
});

const FAILING = (attempts: number) =>
	({
		state: "starting",
		login: "mona",
		failure: { attempts, reason: "exit 1", at: AT },
	}) as const;
const STARTING = { state: "starting", login: "mona" } as const;
const AWAY = { state: "disconnected", login: "mona" } as const;
const HEALTHY = { state: "attached", login: "mona" } as const;

/**
 * What the live region is told, in order, as the Planner and the room's connection follow one
 * another the way the page feeds them: a status whose machine is not known yet is withheld (held),
 * and a lost socket takes precedence over every Planner state.
 */
function told(
	steps: ReadonlyArray<
		[planner: Session.PlannerAttachment | undefined, machine: string | null, lost?: boolean]
	>,
): { heard: string[]; text: string } {
	let heard: string[] = [];
	let text = "";
	let memory = INITIAL_MEMORY;
	let spoken: Spoken = NOTHING_SPOKEN;
	for (let [planner, machine, lost = false] of steps) {
		// Each step is later than the resumed words last: they have been said and have gone.
		memory = expireResumed(memory);
		let held = plannerWithheld(planner, machine);
		let result = connectionStep(memory, {
			...WELL,
			socket: lost ? "lost" : "up",
			planner: held ? undefined : plannerStatus(planner, machine),
		});
		memory = result.memory;
		let speech = connectionSpeech(spoken, result.view, held);
		if (!speech) continue;
		spoken = speech.spoken;
		text = speech.said;
		if (text) heard.push(text);
	}
	return { heard, text };
}

test("a state is not said again when it is entered again after only a gap in which its status was withheld", () => {
	expect(
		told([
			[FAILING(1), "Build box"],
			[FAILING(2), "Build box"],
			[FAILING(2), null],
			[FAILING(3), "Build box"],
			[FAILING(3), null],
			[FAILING(4), "Build box"],
		]).heard,
	).toEqual(["Can't connect to Build box."]);
	expect(told([[STARTING, "Box B"], [STARTING, null], [STARTING, "Box B"]]).heard).toEqual([
		"Connecting to Box B",
	]);
	// A different state is said once it is named, however long the gap before it was.
	expect(told([[STARTING, "Box B"], [AWAY, null], [AWAY, null], [AWAY, "Box C"]]).heard).toEqual([
		"Connecting to Box B",
		"Box C is offline. Your work is kept.",
	]);
	// A first state is not said at all until a machine is named for it.
	expect(told([[STARTING, null], [STARTING, null]])).toEqual({ heard: [], text: "" });
});

test("a Planner state that carried on through a loss is not said again, a different one is said once, and a healthy return forgets it", () => {
	expect(told([[AWAY, "Box B"], [AWAY, "Box B", true], [AWAY, "Box B"]]).heard).toEqual([
		"Box B is offline. Your work is kept.",
		"Reconnecting. Your changes are kept.",
		"Back online. Your changes are synced",
	]);
	// Another machine's name for the same state is still the state carrying on.
	let carried = told([[AWAY, "Box B"], [AWAY, "Box C", true], [AWAY, "Box C"]]).heard;
	expect(carried.filter(words => words.includes("is offline"))).toEqual([
		"Box B is offline. Your work is kept.",
	]);
	// Healthy again by the time the connection returns: nothing more is said of it, and it is said
	// again if it recurs.
	let recurring = told([
		[AWAY, "Box B"],
		[HEALTHY, null, true],
		[HEALTHY, null],
		[HEALTHY, null],
		[AWAY, "Box B"],
	]);
	expect(recurring.heard.filter(words => words.includes("is offline"))).toEqual([
		"Box B is offline. Your work is kept.",
		"Box B is offline. Your work is kept.",
	]);
});

test("a state is said again when it is entered again after the Planner was healthy or gone", () => {
	expect(told([[STARTING, "Box B"], [HEALTHY, null], [STARTING, null], [STARTING, "Box B"]]))
		.toEqual({
			heard: ["Connecting to Box B", "Connecting to Box B"],
			text: "Connecting to Box B",
		});
	expect(told([[STARTING, "Box B"], [undefined, null], [STARTING, "Box B"]]).heard).toEqual([
		"Connecting to Box B",
		"Connecting to Box B",
	]);
});
