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
	plannerSpeech,
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

test("with the machine button, the button carries every state, a machine that cannot be connected to included, and the composer is left alone", () => {
	for (let planner of PROBLEMS) {
		let status = plannerStatus(planner, "Build box")!;
		let placed = plannerPlacement(status, true);
		expect(placed.button).toBe(status);
		expect(placed.strip).toBeUndefined();
	}
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
		link: { label: "How to fix", href: PLANNER_HOW_TO_FIX },
	});
});

test("while the page's offline notice shows, the composer's strip says nothing of a machine, and the machine button keeps its state", () => {
	for (let planner of PROBLEMS) {
		let status = plannerStatus(planner, "Build box")!;
		expect(plannerPlacement(status, false, true)).toEqual({ button: undefined, strip: undefined });
		expect(plannerPlacement(status, true, true)).toEqual({ button: status, strip: undefined });
		// The strip is back, whole, as the notice goes.
		expect(plannerPlacement(status, false, false)).toEqual(plannerPlacement(status, false));
		expect(plannerPlacement(status, false, false).strip).toBeDefined();
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

/**
 * What a live region is told, in order, and what it holds at the end, as `steps` follow one
 * another, each with whether the page's offline notice shows then.
 */
function spoken(
	steps: ReadonlyArray<
		[planner: Session.PlannerAttachment | undefined, machine: string | null, offline?: boolean]
	>,
): { heard: string[]; text: string } {
	let heard: string[] = [];
	let text = "";
	let previous: Parameters<typeof plannerSpeech>[0];
	for (let [planner, machine, offline = false] of steps) {
		let speech = plannerSpeech(
			previous,
			plannerStatus(planner, machine),
			plannerWithheld(planner, machine),
			offline,
		);
		if (!speech) continue;
		previous = speech.kind;
		text = speech.said;
		if (text) heard.push(text);
	}
	return { heard, text };
}

test("a state is not said again when it is entered again after only a gap in which its status was withheld", () => {
	let starting = { state: "starting", login: "mona" } as const;
	let dropped = { state: "disconnected", login: "mona" } as const;
	// A word that repeats the state with one more attempt, told while the machine list is read again.
	expect(
		spoken([
			[failing(1), "Build box"],
			[failing(2), "Build box"],
			[failing(2), null],
			[failing(3), "Build box"],
			[failing(3), null],
			[failing(4), "Build box"],
		]).heard,
	).toEqual(["Can't connect to Build box."]);
	// The same state entered again through a gap, once the machine is named again.
	expect(spoken([[starting, "Box B"], [starting, null], [starting, "Box B"]]).heard).toEqual([
		"Connecting to Box B",
	]);
	// A different state is said once it is named, however long the gap before it was.
	expect(spoken([[starting, "Box B"], [dropped, null], [dropped, null], [dropped, "Box C"]]))
		.toEqual({
			heard: ["Connecting to Box B", "Box C is offline. Your work is kept."],
			text: "Box C is offline. Your work is kept.",
		});
	// A first state is not said at all until a machine is named for it.
	expect(spoken([[starting, null], [starting, null]])).toEqual({ heard: [], text: "" });
	expect(spoken([[starting, null], [starting, null], [starting, "Box B"]]).heard).toEqual([
		"Connecting to Box B",
	]);
});

test("a live region holds nothing while a status is withheld, and says nothing more for the state it already said", () => {
	let starting = { state: "starting", login: "mona" } as const;
	// Nothing stale is left in the region through the gap, nor put back after it.
	expect(spoken([[starting, "Box B"]]).text).toBe("Connecting to Box B");
	expect(spoken([[starting, "Box B"], [starting, null]]).text).toBe("");
	expect(spoken([[starting, "Box B"], [starting, null], [starting, "Box B"]])).toEqual({
		heard: ["Connecting to Box B"],
		text: "",
	});
});

test("while the page's offline notice shows, a live region is empty and says nothing new, whatever the status does", () => {
	let starting = { state: "starting", login: "mona" } as const;
	let dropped = { state: "disconnected", login: "mona" } as const;
	// What it had said is cleared from it at once, and it stays empty for as long as the notice does.
	expect(spoken([[dropped, "Box B"], [dropped, "Box B", true]])).toEqual({
		heard: ["Box B is offline. Your work is kept."],
		text: "",
	});
	// A state released from the wait for a newer read, whose grace ends beside the notice, is not said.
	expect(plannerSpeech("disconnected", plannerStatus(starting, "Box C"), false, true)).toEqual({
		kind: "disconnected",
		said: "",
	});
	expect(
		spoken([[dropped, "Box B"], [dropped, null, true], [starting, "Box C", true], [
			starting,
			"Box C",
			true,
		]]),
	).toEqual({ heard: ["Box B is offline. Your work is kept."], text: "" });
	// With nothing said and nothing held, it has nothing to remember or to clear.
	expect(plannerSpeech(undefined, plannerStatus(starting, "Box C"), false, true)).toBeUndefined();
	expect(plannerSpeech(undefined, undefined, false, true)).toBeUndefined();
});

test("a state that carried on through the loss is not said again when the connection returns, and a different one is said once", () => {
	let starting = { state: "starting", login: "mona" } as const;
	let dropped = { state: "disconnected", login: "mona" } as const;
	let attached = { state: "attached", login: "mona" } as const;
	expect(spoken([[dropped, "Box B"], [dropped, "Box B", true], [dropped, "Box B"]])).toEqual({
		heard: ["Box B is offline. Your work is kept."],
		text: "",
	});
	// Another machine's name for the same state is still the state carrying on.
	expect(spoken([[dropped, "Box B"], [dropped, "Box C", true], [dropped, "Box C"]]).heard).toEqual([
		"Box B is offline. Your work is kept.",
	]);
	// The state it returns to is another, and is said once, however long the loss lasted.
	expect(
		spoken([[dropped, "Box B"], [starting, "Box C", true], [starting, "Box C", true], [
			starting,
			"Box C",
		], [starting, "Box C"]]),
	).toEqual({
		heard: ["Box B is offline. Your work is kept.", "Connecting to Box C"],
		text: "Connecting to Box C",
	});
	// Healthy again by the time the connection returns: nothing is said, and the state it had
	// said is forgotten, so it is said again if it recurs.
	expect(spoken([[dropped, "Box B"], [attached, null, true], [attached, null]])).toEqual({
		heard: ["Box B is offline. Your work is kept."],
		text: "",
	});
	expect(
		spoken([[dropped, "Box B"], [attached, null, true], [attached, null], [dropped, "Box B"]])
			.heard,
	).toEqual(["Box B is offline. Your work is kept.", "Box B is offline. Your work is kept."]);
});

test("a state is said again when it is entered again after the Planner was healthy or gone", () => {
	let starting = { state: "starting", login: "mona" } as const;
	let attached = { state: "attached", login: "mona" } as const;
	expect(spoken([[starting, "Box B"], [attached, null], [starting, null], [starting, "Box B"]]))
		.toEqual({
			heard: ["Connecting to Box B", "Connecting to Box B"],
			text: "Connecting to Box B",
		});
	expect(spoken([[starting, "Box B"], [{ state: "none" }, null], [starting, "Box B"]]).heard)
		.toEqual(["Connecting to Box B", "No machine is connected.", "Connecting to Box B"]);
	expect(spoken([[starting, "Box B"], [undefined, null], [starting, "Box B"]]).heard).toEqual([
		"Connecting to Box B",
		"Connecting to Box B",
	]);
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
