import { describe, expect, it } from "bun:test";

import { carriedByMarkers } from "./widgets/questionnaire";
import {
	keyOf,
	markerPoint,
	markerReach,
	point,
	popoverBelow,
	prune,
	shown,
	unchosen,
	verticalReach,
} from "./resolved";

import type { Question, Questionnaire } from "@chopin/dialect";
import type { Rect } from "./comment-geometry";
import type { PointerState } from "./resolved";

function question(
	answer: string | undefined,
	multiple = false,
	labels = ["All at once", "Team by team", "Phased"],
): Question {
	return {
		id: "q",
		header: "Rollout",
		prompt: "How?",
		multiple,
		options: labels.map((label, index) => ({ id: `o${index}`, label })),
		...(answer === undefined ? {} : { answer }),
	};
}

function box(left: number, top: number, width: number, height: number): Rect {
	return { left, top, width, height, right: left + width, bottom: top + height };
}

describe("unchosen options", () => {
	it("lists the other options in definition order", () => {
		expect(unchosen(question("Team by team"))).toEqual(["All at once", "Phased"]);
	});

	it("reads a multiple choice back out of its joined answer", () => {
		expect(unchosen(question("Phased, All at once", true))).toEqual(["Team by team"]);
	});

	it("matches whole labels even when a label contains the separator", () => {
		let labels = ["Ship, then measure", "Ship", "Wait"];
		expect(unchosen(question("Ship, then measure", false, labels))).toEqual(["Ship", "Wait"]);
		expect(unchosen(question("Ship, Wait", true, labels))).toEqual(["Ship, then measure"]);
	});

	it("says nothing for a custom answer", () => {
		expect(unchosen(question("Something else entirely"))).toBeUndefined();
		expect(unchosen(question("Team by team, plus more", true))).toBeUndefined();
	});

	it("says nothing when it cannot match exactly", () => {
		expect(unchosen(question("team by team"))).toBeUndefined();
		expect(unchosen(question("Team by team, Phased"))).toBeUndefined();
		expect(unchosen(question(undefined))).toBeUndefined();
		expect(unchosen(question("", false))).toBeUndefined();
		expect(unchosen(question("A", false, []))).toBeUndefined();
	});

	it("does not count one option twice", () => {
		expect(unchosen(question("Phased, Phased", true))).toBeUndefined();
	});
});

describe("hover and pin", () => {
	let a = keyOf({ widget: "w", question: "a" });
	let b = keyOf({ widget: "w", question: "b" });

	it("shows a hover and lets go of it", () => {
		let state = point({}, { type: "enter", key: a });
		expect(shown(state)).toEqual({ key: a, pinned: false });
		expect(shown(point(state, { type: "leave", key: a }))).toBeUndefined();
	});

	it("keeps a pin after the pointer leaves", () => {
		let state = point(point({}, { type: "enter", key: a }), { type: "toggle", key: a });
		state = point(state, { type: "leave", key: a });
		expect(shown(state)).toEqual({ key: a, pinned: true });
	});

	it("toggles off from the marker", () => {
		let pinned = point({}, { type: "toggle", key: a });
		expect(point(pinned, { type: "toggle", key: a }).pinned).toBeUndefined();
	});

	it("holds one pin: pinning another replaces it", () => {
		let state = point(point({}, { type: "toggle", key: a }), { type: "toggle", key: b });
		expect(state.pinned).toBe(b);
	});

	it("lets a hover borrow the popover from the pin and give it back", () => {
		let state: PointerState = { pinned: a };
		state = point(state, { type: "enter", key: b });
		expect(shown(state)).toEqual({ key: b, pinned: false });
		state = point(state, { type: "leave", key: b });
		expect(shown(state)).toEqual({ key: a, pinned: true });
	});

	it("ignores the leave of something that is not hovered", () => {
		let state: PointerState = { hover: a };
		expect(point(state, { type: "leave", key: b })).toBe(state);
	});

	it("dismisses both", () => {
		expect(point({ hover: a, pinned: b }, { type: "dismiss" })).toEqual({});
	});

	it("forgets decisions that lost their prose", () => {
		expect(prune({ hover: a, pinned: b }, new Set([b]))).toEqual({ hover: undefined, pinned: b });
		let same: PointerState = { pinned: a };
		expect(point(same, { type: "prune", live: new Set([a]) })).toBe(same);
	});
});

describe("marker and popover placement", () => {
	let host = box(0, 0, 800, 600);

	it("sits in the gutter, centred on the first line", () => {
		expect(markerPoint(box(100, 50, 600, 80), 32, host, 24)).toEqual({
			top: 54,
			left: 68,
			compact: false,
		});
	});

	it("uses the measured marker size for centering and compact placement", () => {
		expect(markerPoint(box(100, 50, 600, 80), 40, host, 32)).toEqual({
			top: 54,
			left: 60,
			compact: false,
		});
		expect(markerPoint(box(42, 50, 600, 80), 40, host, 40)).toEqual({
			top: 50,
			left: 30,
			compact: true,
		});
	});

	it("becomes a slim bar on the first line when the gutter is too narrow", () => {
		let narrow = markerPoint(box(16, 50, 300, 80), 32, box(0, 0, 360, 600), 24);
		expect(narrow).toEqual({ top: 50, left: 4, compact: true });
		expect(markerPoint(box(8, 50, 300, 80), 32, box(0, 0, 360, 600), 24).left).toBe(0);
	});

	it("never leaves the host", () => {
		expect(markerPoint(box(1000, 50, 100, 20), 20, host, 24).left).toBeLessThanOrEqual(776);
		expect(markerPoint(box(2, 50, 100, 20), 20, host, 24).left).toBeGreaterThanOrEqual(0);
	});

	it("reaches 12px past the marker but stops at the page edge and the prose", () => {
		expect(markerReach(72, 20, 100)).toEqual({ start: 12, end: 8 });
		expect(markerReach(100, 20, 200)).toEqual({ start: 12, end: 12 });
		expect(markerReach(4, 12, 16)).toEqual({ start: 4, end: 0 });
		expect(markerReach(0, 12, 8)).toEqual({ start: 0, end: 0 });
	});

	it("splits the gap between markers closer than their reach", () => {
		expect(verticalReach([{ top: 0, height: 20 }, { top: 36, height: 20 }])).toEqual([
			{ top: 12, bottom: 8 },
			{ top: 8, bottom: 12 },
		]);
		expect(verticalReach([{ top: 0, height: 20 }, { top: 100, height: 20 }])).toEqual([
			{ top: 12, bottom: 12 },
			{ top: 12, bottom: 12 },
		]);
	});

	it("opens under the block, aligned to its start, and flips at the bottom", () => {
		expect(popoverBelow(box(100, 50, 600, 80), host, 336, 120)).toEqual({ top: 138, left: 100 });
		expect(popoverBelow(box(100, 500, 600, 60), host, 336, 120).top).toBe(372);
		expect(popoverBelow(box(700, 50, 90, 20), host, 336, 100).left).toBe(464);
	});
});

describe("a card carried by markers", () => {
	function value(...answers: (string | undefined)[]): Questionnaire {
		return {
			id: "w",
			questions: answers.map((answer, index) => ({ ...question(answer), id: `q${index}` })),
		};
	}

	it("collapses only when every question is answered and linked", () => {
		expect(carriedByMarkers(value("A"), { q0: 1 })).toBe(true);
		expect(carriedByMarkers(value("A", "B"), { q0: 1, q1: 2 })).toBe(true);
	});

	it("stays a compact card when pending, empty, orphaned, or partly linked", () => {
		expect(carriedByMarkers(value("A"), { q0: 0 })).toBe(false);
		expect(carriedByMarkers(value("A"), {})).toBe(false);
		expect(carriedByMarkers(value("A", "B"), { q0: 1, q1: 0 })).toBe(false);
		expect(carriedByMarkers(value("A"), undefined)).toBe(false);
		expect(carriedByMarkers(value(undefined), { q0: 1 })).toBe(false);
	});
});
