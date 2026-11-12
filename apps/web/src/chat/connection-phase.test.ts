import { expect, test } from "bun:test";

import {
	connectionSpeech,
	connectionStep,
	expireResumed,
	INITIAL_MEMORY,
	NOTHING_SPOKEN,
	offlineBar,
	plannerForBanner,
	RESUMED_MS,
	silencesFailedSends,
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

test("a lost socket reconnects, and never counts its attempts for a person", () => {
	let { view } = step(INITIAL_MEMORY, { socket: "lost", failures: 0 });
	expect(view).toEqual({
		phase: "reconnecting",
		layer: "socket",
		text: "Connecting\u2026 Your changes are kept.",
	});
	expect(run({ socket: "lost", failures: 2 }).view).toEqual(view);
});

test("a socket whose automatic attempts keep failing is dropped, and Reconnect asks for the socket", () => {
	let { view } = step(INITIAL_MEMORY, { socket: "lost", failures: 4 });
	expect(view).toMatchObject({ phase: "dropped", layer: "socket", action: "reconnect" });
	expect(offlineBar(view)).toMatchObject({ action: "reconnect" });
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

test("Reconnect shows connecting until the attempt it starts fails", () => {
	let pressed = run({ socket: "lost", failures: 4, retrying: 4 });
	expect(pressed.view).toMatchObject({ phase: "reconnecting", layer: "socket" });
	expect("attempt" in pressed.view).toBe(false);
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

test("a return waits for edits to be acknowledged before saying they are synced", () => {
	let loss = step(INITIAL_MEMORY, { socket: "lost" });
	let back = step(loss.memory, { unsaved: true });
	expect(back.view).toEqual({ phase: "resumed", text: "Back online.", caught: "" });
	let said = connectionSpeech(NOTHING_SPOKEN, back.view)!;
	expect(said.said).toBe("Back online.");

	let saved = step(back.memory, { unsaved: false });
	expect(saved.view).toEqual({
		phase: "resumed",
		text: "Back online.",
		caught: "Your changes are synced",
	});
	expect(connectionSpeech(said.spoken, saved.view)).toBeUndefined();
	// A later edit may be pending while the same return is still shown.
	let editing = step(saved.memory, { unsaved: true });
	expect(editing.view).toMatchObject({ caught: "" });
	expect(step(editing.memory, { unsaved: false }).view).toMatchObject({
		caught: "Your changes are synced",
	});
});

test("edits lost while awaiting acknowledgement are never called synced", () => {
	let loss = step(INITIAL_MEMORY, { socket: "lost", lostEdits: 0 });
	let back = step(loss.memory, { unsaved: true, lostEdits: 0 });
	let reset = step(back.memory, { unsaved: false, lostEdits: 1 });
	expect(reset.view).toEqual({ phase: "resumed", text: "Back online.", caught: "" });
	expect(step(reset.memory, { unsaved: false, lostEdits: 1 }).view).toEqual(reset.view);
});

test("a return with new messages keeps those words while edits are acknowledged", () => {
	let loss = step(INITIAL_MEMORY, { socket: "lost", messages: 12 });
	let back = step(loss.memory, { unsaved: true, messages: 14 });
	expect(back.view).toMatchObject({ caught: "2 new messages" });
	expect(step(back.memory, { unsaved: false, messages: 14 }).view).toEqual(back.view);
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
	expect(view).toMatchObject({ phase: "reconnecting", layer: "socket" });
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

test("a machine that cannot be connected to is dropped, and is said in one sentence", () => {
	let failing = plannerStatus({
		state: "starting",
		login: "mona",
		failure: { attempts: 3, reason: "exit 1", at: AT },
	}, "Build box");
	let { view } = step(INITIAL_MEMORY, { planner: failing });
	expect(view).toEqual({
		phase: "dropped",
		layer: "planner",
		plannerKind: "cant-start",
		text: "Can't connect to Build box.",
	});
	// Its why, its steps and Try again are the machine button's menu's (`machine-fix.ts`), never a bar.
	expect(offlineBar(view)).toBeUndefined();
});

test("no machine at all is dropped, with nothing to retry from here", () => {
	let none = plannerStatus({ state: "none" });
	let { view } = step(INITIAL_MEMORY, { planner: none });
	expect(view).toMatchObject({
		phase: "dropped",
		layer: "planner",
		text: "No machine is connected.",
	});
	expect("action" in view).toBe(false);
	expect(offlineBar(view)).toBeUndefined();
});

test("a machine button already carries no machine, so only the button's absence has the page say it", () => {
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

test("the Planner's state is never drawn and offers nothing from the page, whatever it is", () => {
	let attachments: Session.PlannerAttachment[] = [
		{ state: "disconnected", login: "mona" },
		{ state: "held", login: "mona", until: AT },
		{ state: "starting", login: "mona" },
		{ state: "starting", login: "mona", failure: { attempts: 3, reason: "exit 1", at: AT } },
		{ state: "none" },
	];
	for (let attachment of attachments) {
		let view = step(INITIAL_MEMORY, { planner: plannerStatus(attachment, "Build box") }).view;
		expect(view).toMatchObject({ layer: "planner" });
		expect("action" in view).toBe(false);
		expect(offlineBar(view)).toBeUndefined();
	}
});

test("only the room's socket, lost for a while, is drawn: as reconnecting, then offline with Reconnect", () => {
	expect(offlineBar(step(INITIAL_MEMORY, {}).view)).toBeUndefined();
	expect(offlineBar(step(INITIAL_MEMORY, { socket: "lost", failures: 2 }).view)).toEqual({
		phase: "reconnecting",
		text: "Connecting\u2026 Your changes are kept.",
	});
	expect(
		offlineBar(step(INITIAL_MEMORY, { socket: "lost", failures: RETRY_AFTER_FAILURES }).view),
	).toEqual({
		phase: "dropped",
		text: "You're offline. Your changes are kept.",
		action: "reconnect",
	});
	// Catching up on the socket's return, and the return itself, are quiet: nothing is drawn.
	expect(offlineBar(run({ socket: "lost" }, { synced: false }).view)).toBeUndefined();
	let back = run({ socket: "lost" }, { socket: "up" });
	expect(back.view.phase).toBe("resumed");
	expect(offlineBar(back.view)).toBeUndefined();
	// A machine behind a lost socket is the socket's to tell, and the bar says only the socket.
	let away = plannerStatus({ state: "disconnected", login: "mona" }, "Build box");
	expect(offlineBar(step(INITIAL_MEMORY, { socket: "lost", planner: away }).view)).toMatchObject({
		phase: "reconnecting",
	});
});

test("only a banner that says the same cause as a refused send gives that send's line its quiet", () => {
	let none = plannerStatus({ state: "none" });
	let away = plannerStatus({ state: "disconnected", login: "mona" }, "Build box");
	// The room's socket being down is the cause a send could not go, so the banner speaks for it,
	// and while it says it is back; the send's own line returns after.
	let lost = step(INITIAL_MEMORY, { socket: "lost" });
	expect(silencesFailedSends(lost.view)).toBe(true);
	expect(silencesFailedSends(run({ socket: "lost" }, { socket: "up" }).view)).toBe(true);
	expect(silencesFailedSends(run({ socket: "lost" }, { synced: false }).view)).toBe(true);
	// A Planner that is absent says nothing of why the server turned a message down for good.
	expect(silencesFailedSends(step(INITIAL_MEMORY, { planner: none }).view)).toBe(false);
	expect(silencesFailedSends(step(INITIAL_MEMORY, { planner: away }).view)).toBe(false);
	let back = run({ planner: away }, { planner: undefined, plannerAttached: true });
	expect(back.view).toMatchObject({ phase: "resumed", layer: "planner" });
	expect(silencesFailedSends(back.view)).toBe(false);
	expect(silencesFailedSends({ phase: "online" })).toBe(false);
	// The socket's banner stands in front of the Planner's, so a Planner absence behind a lost
	// socket is one banner, and it is the socket's.
	expect(silencesFailedSends(step(INITIAL_MEMORY, { socket: "lost", planner: none }).view)).toBe(
		true,
	);
});

test("a screen reader hears each phase once, and nothing as the banner goes", () => {
	let reconnecting = step(INITIAL_MEMORY, { socket: "lost", failures: 0 }).view;
	let again = step(INITIAL_MEMORY, { socket: "lost", failures: 1 }).view;
	let dropped = step(INITIAL_MEMORY, { socket: "lost", failures: 4 }).view;
	let first = connectionSpeech(NOTHING_SPOKEN, reconnecting)!;
	expect(first.said).toBe("Connecting\u2026 Your changes are kept.");
	// One more attempt is the same phase: nothing new to say.
	expect(connectionSpeech(first.spoken, again)).toBeUndefined();
	let second = connectionSpeech(first.spoken, dropped)!;
	expect(second.said).toBe(
		"You're offline. Your changes are kept.",
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

test("a withheld Planner status clears the live region without saying the same state twice", () => {
	let view = step(INITIAL_MEMORY, {
		planner: plannerStatus({ state: "disconnected", login: "mona" }, "Build box"),
	}).view;
	let said = connectionSpeech(NOTHING_SPOKEN, view)!;
	// Withheld: clear the words, but remember what was said.
	let gap = connectionSpeech(said.spoken, { phase: "online" }, true)!;
	expect(gap.said).toBe("");
	expect(gap.spoken).toEqual(said.spoken);
	expect(connectionSpeech(gap.spoken, view)).toBeUndefined();
	let starting = step(INITIAL_MEMORY, {
		planner: plannerStatus({ state: "starting", login: "mona" }, "Build box"),
	}).view;
	expect(connectionSpeech(gap.spoken, starting)?.said).toBe("Connecting to Build box");
	// Gone for good, it is said again when it comes back.
	let gone = connectionSpeech(gap.spoken, { phase: "online" })!;
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

test("distinct dropped Planner states are each spoken once, including a return to no machine", () => {
	let none = { state: "none" } as const;
	let held = { state: "held", login: "mona", until: AT } as const;
	let result = told([
		[none, null],
		[none, null],
		[held, null],
		[held, null],
		[none, null],
		[none, null],
		[AWAY, "Build box"],
		[FAILING(1), "Build box"],
		[FAILING(2), "Build box"],
	]);
	expect(result.heard).toEqual([
		"No machine is connected.",
		expect.stringMatching(/^@mona's machine stepped away\. Your work is kept until /),
		"No machine is connected.",
		"Build box is offline. Your work is kept.",
		"Can't connect to Build box.",
	]);
});

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
		"Connecting\u2026 Your changes are kept.",
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

const PLANNER_AWAY = plannerStatus({ state: "disconnected", login: "mona" }, "Build box");
const PLANNER_HELD = plannerStatus({ state: "held", login: "mona", until: AT }, "Build box");

test("a machine that returns after its drop was shown says so, and that the reply kept going only while the same one still runs", () => {
	for (let planner of [PLANNER_AWAY, PLANNER_HELD]) {
		let { view } = run(
			{ planner, turn: "t1", messages: 12 },
			{ plannerAttached: true, turn: "t1", messages: 14 },
		);
		expect(view).toEqual({
			phase: "resumed",
			layer: "planner",
			text: "The machine is back. The reply kept going.",
			caught: "2 new messages",
		});
	}
});

test("a reply that is gone when the machine returns is said to have ended, never to have kept going", () => {
	for (let turn of [undefined, "t2"]) {
		let { view } = run(
			{ planner: PLANNER_AWAY, turn: "t1", messages: 12 },
			{ plannerAttached: true, turn, messages: 13 },
		);
		expect(view).toEqual({
			phase: "resumed",
			layer: "planner",
			text: "The machine is back. The reply ended while it was away.",
			caught: "1 new message",
		});
	}
});

test("no reply running when the machine dropped means nothing is claimed about one on its return", () => {
	let { view } = run({ planner: PLANNER_AWAY, turn: undefined }, {
		plannerAttached: true,
		turn: "t9",
	});
	expect(view).toEqual({
		phase: "resumed",
		layer: "planner",
		text: "The machine is back.",
		caught: "Nothing new while it was away.",
	});
});

test("a Planner state that is only withheld or hidden is not a return, and the return is still told once it is real", () => {
	let gap = run({ planner: PLANNER_AWAY, turn: "t1" }, { planner: undefined, turn: "t1" });
	expect(gap.view).toEqual({ phase: "online" });
	let back = step(gap.memory, { plannerAttached: true, turn: "t1" });
	expect(back.view).toMatchObject({ phase: "resumed", layer: "planner" });
});

test("a machine that is starting or failing to start after a drop was shown keeps the drop to compare with", () => {
	let starting = plannerStatus({ state: "starting", login: "mona" }, "Build box");
	let failing = plannerStatus(
		{ state: "starting", login: "mona", failure: { attempts: 2, reason: "x", at: AT } },
		"Build box",
	);
	let { view } = run(
		{ planner: PLANNER_AWAY, turn: "t1", messages: 12 },
		{ planner: starting, turn: "t1", messages: 12 },
		{ planner: failing, turn: "t1", messages: 12 },
		{ plannerAttached: true, turn: "t1", messages: 12 },
	);
	expect(view).toMatchObject({
		phase: "resumed",
		text: "The machine is back. The reply kept going.",
	});
});

test("a first connection, and a machine that was never shown dropped, is no return", () => {
	let starting = plannerStatus({ state: "starting", login: "mona" }, "Build box");
	expect(run({ planner: starting }, { plannerAttached: true }).view).toEqual({ phase: "online" });
	expect(run({ plannerAttached: true }).view).toEqual({ phase: "online" });
});

test("no machine told after a drop makes the next attachment a new machine, not a return", () => {
	let none = plannerStatus({ state: "none" });
	expect(run({ planner: PLANNER_AWAY }, { planner: none }, { plannerAttached: true }).view)
		.toEqual({ phase: "online" });
});

test("a return is told only once the transcript on screen is this socket's own, so a restart waited out in silence claims nothing", () => {
	let waiting = run(
		{ planner: PLANNER_AWAY, turn: "t1", messages: 12 },
		{ plannerAttached: true, current: false, turn: undefined, messages: 0 },
	);
	expect(waiting.view).toEqual({ phase: "online" });
	let arrived = step(waiting.memory, { plannerAttached: true, turn: "t1", messages: 12 });
	expect(arrived.view).toMatchObject({
		phase: "resumed",
		text: "The machine is back. The reply kept going.",
		caught: "Nothing new while it was away.",
	});
});

test("the machine's return is said briefly and then the banner goes", () => {
	let back = run({ planner: PLANNER_AWAY }, { plannerAttached: true });
	expect(back.view.phase).toBe("resumed");
	expect(connectionStep(expireResumed(back.memory), { ...WELL, plannerAttached: true }).view)
		.toEqual({ phase: "online" });
});

test("the machine returning together with the socket is one return, told by the socket", () => {
	let { view, memory } = run(
		{ planner: PLANNER_AWAY, turn: "t1", messages: 12 },
		{ socket: "lost", turn: "t1", messages: 12 },
		{ plannerAttached: true, turn: "t1", messages: 13 },
	);
	expect(view).toEqual({
		phase: "resumed",
		text: "Back. The reply kept going.",
		caught: "1 new message",
	});
	// Nothing more about the machine is left to say once that has gone.
	expect(
		connectionStep(expireResumed(memory), { ...WELL, plannerAttached: true, messages: 13 }).view,
	)
		.toEqual({ phase: "online" });
});

test("a machine still away when the socket returns is told after the socket's return, and its own return after that", () => {
	let sequence = run(
		{ planner: PLANNER_AWAY, turn: "t1", messages: 12 },
		{ socket: "lost", turn: "t1", messages: 12 },
		{ planner: PLANNER_AWAY, turn: "t1", messages: 12 },
	);
	expect(sequence.view).toMatchObject({ phase: "resumed" });
	let after = step(expireResumed(sequence.memory), { planner: PLANNER_AWAY, turn: "t1" });
	expect(after.view).toMatchObject({ phase: "dropped", layer: "planner" });
	expect(step(after.memory, { plannerAttached: true, turn: "t1", messages: 12 }).view)
		.toMatchObject({
			phase: "resumed",
			layer: "planner",
		});
});

test("the machine's return is spoken once, and spoken again after a later drop", () => {
	let away = step(INITIAL_MEMORY, { planner: PLANNER_AWAY });
	let said = connectionSpeech(NOTHING_SPOKEN, away.view)!;
	let back = step(away.memory, { plannerAttached: true });
	let returned = connectionSpeech(said.spoken, back.view)!;
	expect(returned.said).toBe("The machine is back. Nothing new while it was away.");
	expect(connectionSpeech(returned.spoken, back.view)).toBeUndefined();
	expect(connectionSpeech(returned.spoken, { phase: "online" })).toEqual({
		spoken: NOTHING_SPOKEN,
		said: "",
	});
	// Dropped again, it is a new drop and is said.
	expect(connectionSpeech(returned.spoken, away.view)?.said).toBe(
		"Build box is offline. Your work is kept.",
	);
});

test("catching up says only that, never which attempt reopened the socket", () => {
	let lostThenBack = run({ socket: "lost", failures: 2 }, { synced: false });
	expect(lostThenBack.view).toEqual({ phase: "reconnecting", layer: "sync", text: "Catching up" });
	let transcript = run({ socket: "lost" }, { current: false });
	expect(transcript.view).toEqual({ phase: "reconnecting", layer: "sync", text: "Catching up" });
});

test("a machine being connected to shows no attempt count", () => {
	let starting = plannerStatus({ state: "starting", login: "mona" }, "Build box");
	let { view } = step(INITIAL_MEMORY, { planner: starting });
	expect(view).toMatchObject({ phase: "reconnecting", layer: "planner" });
	expect("attempt" in view).toBe(false);
});

test("a machine being connected to says only that, whichever launch it waits on", () => {
	let starting = plannerStatus({ state: "starting", login: "mona", attempt: 2 }, "Build box");
	let { view } = step(INITIAL_MEMORY, { planner: starting });
	expect(view).toEqual({
		phase: "reconnecting",
		layer: "planner",
		text: "Connecting to Build box",
		plannerKind: "starting",
	});
	// Said once, as a state: one launch more is not a new thing to hear.
	let again = plannerStatus({ state: "starting", login: "mona", attempt: 3 }, "Build box");
	let first = connectionSpeech(NOTHING_SPOKEN, view)!;
	expect(first.said).toBe("Connecting to Build box");
	expect(connectionSpeech(first.spoken, step(INITIAL_MEMORY, { planner: again }).view))
		.toBeUndefined();
});

test("a return after edits were dropped never says the changes are synced", () => {
	let { view } = run(
		{ socket: "lost", messages: 12, lostEdits: 0 },
		{ messages: 12, lostEdits: 1 },
	);
	expect(view).toEqual({ phase: "resumed", text: "Back online.", caught: "" });
	expect(connectionSpeech(NOTHING_SPOKEN, view)?.said).toBe("Back online.");
	// Edits dropped in an earlier outage are not this one's.
	expect(run({ socket: "lost", lostEdits: 1 }, { lostEdits: 1 }).view).toMatchObject({
		caught: "Your changes are synced",
	});
});

test("connecting to a machine the person moved it to is said once, though connecting went on", () => {
	let toA = plannerStatus({ state: "starting", login: "mona" }, "Box A");
	let toB = plannerStatus({ state: "starting", login: "mona" }, "Box B");
	let first = connectionSpeech(NOTHING_SPOKEN, step(INITIAL_MEMORY, { planner: toA }).view)!;
	expect(first.said).toBe("Connecting to Box A");
	// Without a move the same kind of state is not news, whatever machine it names.
	expect(connectionSpeech(first.spoken, step(INITIAL_MEMORY, { planner: toB }).view))
		.toBeUndefined();
	let moved = connectionSpeech(
		first.spoken,
		step(INITIAL_MEMORY, { planner: toB, plannerMove: 1 }).view,
	)!;
	expect(moved.said).toBe("Connecting to Box B");
	// And only once for that move.
	expect(
		connectionSpeech(moved.spoken, step(INITIAL_MEMORY, { planner: toB, plannerMove: 1 }).view),
	).toBeUndefined();
});
