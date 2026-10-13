import { describe, expect, it } from "bun:test";

import {
	arrange,
	arriveFrames,
	AWAY,
	bringForward,
	leaveFrames,
	lift,
	movingCard,
	position,
	settle,
	slot,
	step,
} from "./deck-order";

let open = (id: string) => ({ id, settled: false });
let done = (id: string) => ({ id, settled: true });

describe("deck order", () => {
	it("starts with open cards in document order and settled cards behind", () => {
		expect(arrange([], [done("a"), open("b"), open("c")])).toEqual(["b", "c", "a"]);
	});

	it("keeps a reader's order when items re-render unchanged", () => {
		expect(arrange(["c", "b", "a"], [done("a"), open("b"), open("c")]))
			.toEqual(["c", "b", "a"]);
	});

	it("drops removed cards and slots a new open card before the settled ones", () => {
		expect(arrange(["c", "b", "a"], [done("a"), open("c"), open("d")]))
			.toEqual(["c", "d", "a"]);
	});

	it("appends a new settled card at the back", () => {
		expect(arrange(["b"], [open("b"), done("z")])).toEqual(["b", "z"]);
	});

	it("does not move a card that has just been answered until settle runs", () => {
		expect(arrange(["b", "c"], [done("b"), open("c")])).toEqual(["b", "c"]);
		expect(settle(["b", "c"], [done("b"), open("c")])).toEqual(["c", "b"]);
	});

	it("settles stably, keeping relative order inside each group", () => {
		expect(settle(["a", "b", "c", "d"], [done("a"), open("b"), done("c"), open("d")]))
			.toEqual(["b", "d", "a", "c"]);
	});

	it("steps through the counted order and stops at either end", () => {
		let items = [open("a"), open("b"), open("c")];
		expect(step(["a", "b", "c"], items, 1)).toEqual(["b", "c", "a"]);
		expect(step(["b", "c", "a"], items, -1)).toEqual(["a", "b", "c"]);
		expect(step(["a", "b", "c"], items, -1)).toBeUndefined();
		expect(step(["c", "a", "b"], items, 1)).toBeUndefined();
		expect(step([], [], 1)).toBeUndefined();
	});

	it("steps from a card brought forward to its counted neighbour", () => {
		let items = [open("a"), open("b"), done("c"), open("d")];
		// Counted order is a, b, d, then the decided c.
		expect(step(["d", "a", "b", "c"], items, 1)).toEqual(["c", "a", "b", "d"]);
		expect(step(["d", "a", "b", "c"], items, -1)).toEqual(["b", "d", "c", "a"]);
	});

	it("brings one card to the top without disturbing the rest", () => {
		expect(bringForward(["a", "b", "c"], "c")).toEqual(["c", "a", "b"]);
		expect(bringForward(["a", "b"], "missing")).toEqual(["a", "b"]);
	});

	it("counts places in the stack, open cards first", () => {
		expect(position([open("a"), open("b"), open("c")], "c")).toBe(3);
		expect(position([done("a"), done("b"), open("c"), open("d")], "c")).toBe(1);
		expect(position([done("a"), done("b"), open("c"), open("d")], "a")).toBe(3);
		expect(position([open("a")], undefined)).toBe(0);
	});

	it("peeks four cards, each showing less, and hides deeper ones", () => {
		expect(slot(0)).toEqual({ transform: "translateY(0rem) scale(1)", zIndex: 100, opacity: 1 });
		expect(slot(1).transform).toBe("translateY(-0.875rem) scale(0.97)");
		expect(slot(2).transform).toBe("translateY(-1.5rem) scale(0.945)");
		expect(slot(4).transform).toBe("translateY(-2.25rem) scale(0.91)");
		expect(slot(5)).toEqual({
			transform: "translateY(-2.25rem) scale(0.91)",
			zIndex: 95,
			opacity: 0,
		});
	});

	it("lifts the stage by the deepest card shown", () => {
		expect(lift(1)).toBe("0rem");
		expect(lift(2)).toBe("0.875rem");
		expect(lift(9)).toBe("2.25rem");
	});
});

describe("move frames", () => {
	it("fades the old top card away in front, then brings it in behind", () => {
		let frames = leaveFrames(
			{ transform: "translateY(0rem) scale(1)", opacity: 1 },
			"translateY(-1.5rem) scale(0.945)",
			3,
			false,
		);
		expect(frames.card.map(frame => frame.offset)).toEqual([0, 0.5, 0.5, 1]);
		expect(frames.card.map(frame => frame.zIndex)).toEqual([104, 104, 0, 0]);
		expect(frames.card.map(frame => frame.opacity)).toEqual([1, 0, 0, 1]);
		expect(frames.card[1]!.transform).toBe(AWAY);
		expect(frames.card[3]!.transform).toBe("translateY(-1.5rem) scale(0.945)");
	});

	it("keeps the leaving card's content uncovered until it is out of sight", () => {
		let { cover } = leaveFrames({ transform: "none", opacity: 1 }, "b", 3, false);
		expect(cover.map(frame => [frame.offset, frame.opacity])).toEqual([
			[0, 0],
			[0.5, 0],
			[0.5, 1],
			[1, 1],
		]);
	});

	it("leaves a card that lands deeper than the peeks hidden", () => {
		expect(leaveFrames({ transform: "a", opacity: 1 }, "b", 6, true).card[3]!.opacity).toBe(0);
	});

	it("brings a card back over the deck, from mid-move if it was caught", () => {
		expect(arriveFrames("to", 3)).toEqual([
			{ transform: AWAY, opacity: 0, zIndex: 104 },
			{ transform: "to", opacity: 1, zIndex: 104 },
		]);
		expect(arriveFrames("to", 3, { transform: "mid", opacity: 0.4 })[0])
			.toEqual({ transform: "mid", opacity: 0.4, zIndex: 104 });
	});
});

describe("moving card", () => {
	it("sends the top card back on next, even in a deck of two", () => {
		expect(movingCard(["a", "b"], ["b", "a"], 1)).toEqual({ id: "a", direction: "back" });
	});

	it("brings the new top card forward on previous", () => {
		expect(movingCard(["b", "c", "a"], ["a", "b", "c"], -1))
			.toEqual({ id: "a", direction: "front" });
	});

	it("sends the first card that fell back when settling", () => {
		expect(movingCard(["b", "a", "c"], ["a", "c", "b"])).toEqual({ id: "b", direction: "back" });
		expect(movingCard(["a", "b"], ["a", "b"])).toBeUndefined();
	});
});
