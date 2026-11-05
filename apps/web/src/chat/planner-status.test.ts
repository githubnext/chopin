import { expect, test } from "bun:test";

import {
	clockTime,
	NO_PLANNER,
	PLANNER_HOW_TO_FIX,
	plannerButtonLabel,
	plannerGlyph,
	plannerNotice,
	plannerSentence,
	plannerStatus,
} from "./planner-status";

import type { Session } from "@chopin/protocol";

const AT = "2026-11-04T18:29:00.000Z";

function failing(attempts = 3, reason = "The checkout’s git config sets a credential helper") {
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
		text: "Connecting to @mona’s machine",
	});
});

test("says why a Planner that keeps failing cannot start, in full, and what has been tried", () => {
	expect(plannerStatus(failing(), "Build box")).toEqual({
		kind: "cant-start",
		title: "Can’t connect to Build box",
		reason: "The checkout’s git config sets a credential helper.",
		detail: `Tried 3 times, last at ${clockTime(AT)}. Still trying.`,
	});
});

test("does not double the full stop a reason already ends with, and says a single try once", () => {
	let status = plannerStatus(failing(1, "exit 127: node is missing."));
	expect(status).toMatchObject({
		kind: "cant-start",
		title: "Can’t connect to @mona’s machine",
		reason: "exit 127: node is missing.",
	});
	expect(status).toMatchObject({ detail: expect.stringMatching(/^Tried once, last at /) });
});

test("says a disconnected Planner's work is kept and resumes, naming its machine when it is the viewer's", () => {
	expect(plannerStatus({ state: "disconnected", login: "mona" }, "Build box")).toEqual({
		kind: "disconnected",
		text: "Build box is offline. Its work is kept and picks up when it’s back.",
	});
	expect(plannerStatus({ state: "disconnected", login: "mona" })).toEqual({
		kind: "disconnected",
		text: "@mona’s Planner is offline. Its work is kept and picks up when it’s back.",
	});
});

test("says who detached, that the document is kept, and until when they can reattach", () => {
	let until = "2026-10-12T19:42:00.000Z";
	expect(plannerStatus({ state: "held", login: "mona", until })).toEqual({
		kind: "held",
		text:
			`@mona’s Planner detached. The document and its Decisions are kept, and @mona can reattach until ${
				clockTime(until)
			}.`,
	});
});

test("says what @chopin needs when nothing is attached", () => {
	expect(plannerStatus({ state: "none" })).toEqual({ kind: "none", text: NO_PLANNER });
	expect(NO_PLANNER).toBe("No Planner is attached. @chopin needs one to reply.");
});

test("tells each state as one sentence, a failure's with its stop", () => {
	expect(plannerSentence(plannerStatus(failing(), "Build box")!)).toBe(
		"Can’t connect to Build box.",
	);
	expect(plannerSentence(plannerStatus({ state: "starting", login: "mona" }, "Build box")!)).toBe(
		"Connecting to Build box",
	);
});

test("turns the machine button's dot into a spinner, a warning or a muted grey, and leaves the rest", () => {
	let glyph = (planner: Session.PlannerAttachment, machine?: string) =>
		plannerGlyph(plannerStatus(planner, machine));
	expect(glyph({ state: "starting", login: "mona" }, "Build box")).toBe("starting");
	expect(glyph(failing())).toBe("failing");
	expect(glyph({ state: "disconnected", login: "mona" })).toBe("away");
	expect(glyph({ state: "held", login: "mona", until: AT })).toBe("away");
	// Healthy keeps the machine's own dot, and no Planner is not a state of the machine.
	expect(glyph({ state: "attached", login: "mona" })).toBeUndefined();
	expect(glyph({ state: "none" })).toBeUndefined();
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
		"Runs on Build box. Can’t connect to Build box.",
	);
});

test("always warns on the composer's edge for a Planner that cannot start, reason kept for a screen reader", () => {
	let status = plannerStatus(failing(), "Build box");
	for (let addressed of [false, true]) {
		expect(plannerNotice(status, addressed)).toEqual({
			tone: "warning",
			text: "Can’t connect to Build box.",
			detail: `The checkout’s git config sets a credential helper. Tried 3 times, last at ${
				clockTime(AT)
			}. Still trying.`,
			link: { label: "How to fix", href: PLANNER_HOW_TO_FIX },
		});
	}
});

test("tells any other state on the composer's edge only while the draft is addressed to Chopin", () => {
	for (
		let planner of [
			{ state: "starting", login: "mona" },
			{ state: "disconnected", login: "mona" },
			{ state: "held", login: "mona", until: AT },
			{ state: "none" },
		] as const
	) {
		let status = plannerStatus(planner, "Build box");
		expect(plannerNotice(status, false)).toBeUndefined();
		expect(plannerNotice(status, true)).toEqual({ tone: "info", text: plannerSentence(status!) });
	}
	expect(plannerNotice(undefined, true)).toBeUndefined();
});
