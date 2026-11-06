import { expect, test } from "bun:test";

import {
	clockTime,
	NO_MACHINE,
	PLANNER_HOW_TO_FIX,
	plannerAnnouncement,
	plannerButtonLabel,
	plannerGlyph,
	plannerPlacement,
	plannerSentence,
	plannerStatus,
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

test("names whose machine it is when it is not the viewer's, never the machine itself", () => {
	expect(plannerStatus({ state: "starting", login: "mona" })).toEqual({
		kind: "starting",
		text: "Connecting to @mona's machine",
	});
});

test("says why a Planner that keeps failing cannot start, and what has been tried", () => {
	expect(plannerStatus(failing(), "Build box")).toEqual({
		kind: "cant-start",
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

test("with the machine button, the button carries every state and the composer is left alone but for a machine that cannot be connected to", () => {
	for (let planner of PROBLEMS) {
		let status = plannerStatus(planner, "Build box")!;
		let placed = plannerPlacement(status, true);
		expect(placed.button).toBe(status);
		if (status.kind !== "cant-start") expect(placed.strip).toBeUndefined();
	}
	let status = plannerStatus(failing(), "Build box")!;
	// Its reason is on the button's menu, so the strip hands it to a screen reader only.
	expect(plannerPlacement(status, true).strip).toEqual({
		tone: "warning",
		text: "Can't connect to Build box.",
		detail: [
			"The checkout's git config sets a credential helper",
			`Tried 3 times, last at ${clockTime(AT)}. Still trying.`,
		],
		showDetail: false,
		link: { label: "How to fix", href: PLANNER_HOW_TO_FIX },
		silent: true,
	});
});

test("without the machine button, the composer's strip is the only carrier, and it carries every state", () => {
	for (let planner of PROBLEMS) {
		let status = plannerStatus(planner, "Build box")!;
		let placed = plannerPlacement(status, false);
		expect(placed.button).toBeUndefined();
		expect(placed.strip).toMatchObject({ text: plannerSentence(status), silent: true });
		expect(placed.strip?.tone).toBe(status.kind === "cant-start" ? "warning" : "info");
	}
});

test("without the machine button, a machine that cannot be connected to has its reason drawn, exactly as given", () => {
	let reason = "  path ends in a slash /  ";
	let status = plannerStatus(failing(4, reason))!;
	expect(plannerPlacement(status, false).strip).toMatchObject({
		text: "Can't connect to @mona's machine.",
		detail: [reason, `Tried 4 times, last at ${clockTime(AT)}. Still trying.`],
		showDetail: true,
		link: { label: "How to fix", href: PLANNER_HOW_TO_FIX },
	});
});

test("a healthy Planner has nothing to place, with or without the button", () => {
	for (let hasButton of [true, false]) {
		expect(plannerPlacement(undefined, hasButton)).toEqual({
			button: undefined,
			strip: undefined,
		});
	}
});

test("tells a screen reader each problem state's sentence once as it is entered, and nothing otherwise", () => {
	let said = (
		previous: Parameters<typeof plannerAnnouncement>[0],
		planner: Session.PlannerAttachment | undefined,
	) => plannerAnnouncement(previous, plannerStatus(planner, "Build box"));
	// Entered from healthy, in the machine-first words the button and the strip use.
	expect(said(undefined, { state: "starting", login: "mona" })).toBe("Connecting to Build box");
	expect(said("starting", failing())).toBe("Can't connect to Build box.");
	expect(said("cant-start", { state: "disconnected", login: "mona" })).toBe(
		"Build box is offline. Your work is kept.",
	);
	expect(said(undefined, { state: "none" })).toBe(NO_MACHINE);
	// The same state carrying on, its attempts counting up or its machine's name arriving, is not
	// said again.
	expect(said("cant-start", failing(7))).toBe("");
	expect(said("starting", { state: "starting", login: "mona" })).toBe("");
	// Healthy says nothing, and a state that clears is not followed by a confirmation.
	expect(said(undefined, { state: "attached", login: "mona" })).toBe("");
	expect(said("cant-start", { state: "attached", login: "mona" })).toBe("");
	expect(said("held", undefined)).toBe("");
});
