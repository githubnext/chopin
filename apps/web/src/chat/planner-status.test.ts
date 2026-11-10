import { expect, test } from "bun:test";

import {
	clockTime,
	NO_MACHINE,
	plannerButtonLabel,
	plannerGlyph,
	plannerPlacement,
	plannerSentence,
	plannerStatus,
	plannerWithheld,
} from "./planner-status";

import type { Session } from "@chopin/protocol";

const AT = "2026-11-04T18:29:00.000Z";

function failing(attempts = 3, reason = "The checkout's git config sets a credential helper") {
	return { state: "starting", login: "mona", failure: { attempts, reason, at: AT } } as const;
}

test("shows nothing for a healthy Planner, or where the server reports none at all", () => {
	expect(plannerStatus({ state: "attached", login: "mona" })).toBeUndefined();
	expect(plannerStatus(undefined)).toBeUndefined();
});

test("says what is happening and where while a Planner starts, naming the viewer's machine plainly", () => {
	expect(plannerStatus({ state: "starting", login: "mona" }, "Build box")).toEqual({
		kind: "starting",
		text: "Connecting to Build box",
	});
});

test("carries the launch a starting Planner waits on once an earlier one exited, and none before", () => {
	expect(
		plannerStatus({ state: "starting", login: "mona", attempt: 2 }, "Build box"),
	).toEqual({ kind: "starting", text: "Connecting to Build box", attempt: 2 });
	let first = plannerStatus({ state: "starting", login: "mona" }, "Build box")!;
	expect("attempt" in first).toBe(false);
	// A machine that cannot start is told by what it tried, not by the launch it waits on.
	expect(plannerStatus({ ...failing(), attempt: 4 }, "Build box")).toMatchObject({
		kind: "cant-start",
		attempts: 3,
	});
});

test("says nothing while the machine is not known, rather than a name that may be another machine's", () => {
	expect(plannerStatus({ state: "starting", login: "mona" }, null)).toBeUndefined();
	expect(plannerStatus({ state: "disconnected", login: "mona" }, null)).toBeUndefined();
	expect(plannerStatus(failing(), null)).toBeUndefined();
	// What the Planner's own state says, and needs no machine's name, is still said.
	expect(plannerStatus({ state: "none" }, null)).toEqual({ kind: "none", text: NO_MACHINE });
	expect(plannerStatus({ state: "held", login: "mona", until: AT }, null)).toMatchObject({
		kind: "held",
		text: expect.stringMatching(/^@mona's machine stepped away\./),
	});
});

test("names whose machine it is when it is not the viewer's, never the machine itself", () => {
	expect(plannerStatus({ state: "starting", login: "mona" })).toEqual({
		kind: "starting",
		text: "Connecting to @mona's machine",
	});
});

test("says why a Planner that keeps failing cannot start, and what has been tried", () => {
	expect(plannerStatus(failing(), "Build box")).toEqual({
		kind: "cant-start",
		attempts: 3,
		title: "Can't connect to Build box",
		reason: "The checkout's git config sets a credential helper",
		detail: `Tried 3 times, last at ${clockTime(AT)}. Still trying.`,
	});
	expect(plannerStatus(failing(1))).toMatchObject({
		title: "Can't connect to @mona's machine",
		detail: expect.stringMatching(/^Tried once, last at /),
	});
});

test("keeps the reason exactly as the machine reported it: no trimming, no stop added or removed", () => {
	for (
		let reason of [
			"  path ends in a slash /  ",
			"unsafe-checkout: ~/src/score",
			"exit 127: node is missing.",
			"what?!",
			"first line\nsecond line",
			"",
		]
	) {
		expect(plannerStatus(failing(2, reason))).toMatchObject({ kind: "cant-start", reason });
	}
});

test("says when an offline machine was last seen, as a contact's last seen is said", () => {
	let seen = new Date(Date.now() - 60_000).toISOString();
	expect(plannerStatus({ state: "disconnected", login: "mona" }, "Build box", seen)).toEqual({
		kind: "disconnected",
		text: `Build box is offline. Last seen ${clockTime(seen)}.`,
	});
	// Another day is said with its date, so a machine away since last week is not read as this morning.
	let before = new Date(Date.now() - 3 * 86_400_000).toISOString();
	let text = plannerStatus({ state: "disconnected", login: "mona" }, "Build box", before);
	expect(text).toMatchObject({
		kind: "disconnected",
		text: expect.stringMatching(/^Build box is offline\. Last seen .+\d.*\.$/),
	});
	expect((text as { text: string }).text).not.toBe(
		`Build box is offline. Last seen ${clockTime(before)}.`,
	);
	// Without a time, the work is still said to be kept.
	expect(plannerStatus({ state: "disconnected", login: "mona" }, "Build box")).toEqual({
		kind: "disconnected",
		text: "Build box is offline. Your work is kept.",
	});
});

test("says a disconnected machine is offline and the work is kept, naming it when it is the viewer's", () => {
	expect(plannerStatus({ state: "disconnected", login: "mona" }, "Build box")).toEqual({
		kind: "disconnected",
		text: "Build box is offline. Your work is kept.",
	});
	expect(plannerStatus({ state: "disconnected", login: "mona" })).toEqual({
		kind: "disconnected",
		text: "@mona's machine is offline. Your work is kept.",
	});
});

test("says a machine whose holder stepped away, that the work is kept, and until when", () => {
	let until = "2026-10-12T19:42:00.000Z";
	expect(plannerStatus({ state: "held", login: "mona", until }, "Build box")).toEqual({
		kind: "held",
		text: `Build box stepped away. Your work is kept until ${clockTime(until)}.`,
	});
	expect(plannerStatus({ state: "held", login: "mona", until })).toEqual({
		kind: "held",
		text: `@mona's machine stepped away. Your work is kept until ${clockTime(until)}.`,
	});
});

test("says that a machine is needed when none is connected", () => {
	expect(plannerStatus({ state: "none" })).toEqual({ kind: "none", text: NO_MACHINE });
	expect(NO_MACHINE).toBe("No machine is connected.");
});

test("tells each state as one sentence, a failure's with its stop", () => {
	expect(plannerSentence(plannerStatus(failing(), "Build box")!)).toBe(
		"Can't connect to Build box.",
	);
	expect(plannerSentence(plannerStatus({ state: "starting", login: "mona" }, "Build box")!)).toBe(
		"Connecting to Build box",
	);
});

test("turns the machine button's dot into a spinner, a warning, a muted grey or no dot, and leaves only a healthy one", () => {
	let glyph = (planner: Session.PlannerAttachment, machine?: string) =>
		plannerGlyph(plannerStatus(planner, machine));
	expect(glyph({ state: "starting", login: "mona" }, "Build box")).toBe("starting");
	expect(glyph(failing())).toBe("failing");
	expect(glyph({ state: "disconnected", login: "mona" })).toBe("away");
	expect(glyph({ state: "held", login: "mona", until: AT })).toBe("away");
	// No machine connected is no dot, never the machine's own green; only healthy keeps that.
	expect(glyph({ state: "none" })).toBe("none");
	expect(glyph({ state: "attached", login: "mona" })).toBeUndefined();
	expect(plannerGlyph(undefined)).toBeUndefined();
});

test("adds what is happening to the machine button's name, and leaves a healthy one alone", () => {
	let label = "Runs on Build box";
	expect(plannerButtonLabel(label, undefined)).toBe(label);
	expect(
		plannerButtonLabel(label, plannerStatus({ state: "starting", login: "mona" }, "Build box")),
	)
		.toBe("Runs on Build box. Connecting to Build box");
	expect(plannerButtonLabel(label, plannerStatus(failing(), "Build box"))).toBe(
		"Runs on Build box. Can't connect to Build box.",
	);
});

/** Every problem state a Planner can be in, as the server reports it. */
const PROBLEMS = [
	{ state: "starting", login: "mona" },
	failing(),
	{ state: "disconnected", login: "mona" },
	{ state: "held", login: "mona", until: AT },
	{ state: "none" },
] as const satisfies readonly Session.PlannerAttachment[];

test("with the machine button, the button carries every state, a machine that cannot be connected to included", () => {
	for (let planner of PROBLEMS) {
		let status = plannerStatus(planner, "Build box")!;
		expect(plannerPlacement(status, true).button).toBe(status);
	}
});

test("a word whose machine is not known yet is withheld, not over: only a starting or dropped Planner waits for a name", () => {
	for (
		let planner of [{ state: "starting", login: "mona" }, failing(), {
			state: "disconnected",
			login: "mona",
		}] as const
	) {
		expect(plannerWithheld(planner, null)).toBe(true);
		expect(plannerWithheld(planner, "Build box")).toBe(false);
		expect(plannerWithheld(planner, undefined)).toBe(false);
	}
	// What needs no machine's name, and a healthy Planner, are never waiting for one.
	for (
		let planner of [
			{ state: "attached", login: "mona" },
			{ state: "none" },
			{ state: "held", login: "mona", until: AT },
			undefined,
		] as const
	) {
		expect(plannerWithheld(planner, null)).toBe(false);
	}
});

test("a healthy Planner has nothing to place, with or without the button", () => {
	for (let hasButton of [true, false]) {
		expect(plannerPlacement(undefined, hasButton)).toEqual({ button: undefined });
	}
});
