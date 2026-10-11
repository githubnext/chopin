import { describe, expect, it } from "bun:test";

import {
	arrange,
	bringForward,
	cycle,
	movingCard,
	position,
	settle,
	shuffleFrames,
	slot,
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

	it("cycles through every card in both directions", () => {
		expect(cycle(["a", "b", "c"], 1)).toEqual(["b", "c", "a"]);
		expect(cycle(["a", "b", "c"], -1)).toEqual(["c", "a", "b"]);
		expect(cycle([], 1)).toEqual([]);
	});

	it("brings one card to the top without disturbing the rest", () => {
		expect(bringForward(["a", "b", "c"], "c")).toEqual(["c", "a", "b"]);
		expect(bringForward(["a", "b"], "missing")).toEqual(["a", "b"]);
	});

	it("reports the top card's place in document order", () => {
		expect(position([open("a"), open("b"), open("c")], "c")).toBe(3);
		expect(position([open("a")], undefined)).toBe(0);
	});

	it("peeks two cards and hides deeper ones", () => {
		expect(slot(0)).toEqual({ transform: "translateY(0rem) scale(1)", zIndex: 100, opacity: 1 });
		expect(slot(2).transform).toBe("translateY(-3.75rem) scale(0.92)");
		expect(slot(3)).toEqual({
			transform: "translateY(-3.75rem) scale(0.92)",
			zIndex: 97,
			opacity: 0,
		});
	});
});

describe("shuffle frames", () => {
	it("swaps stacking at the midpoint so the card passes behind the deck", () => {
		let frames = shuffleFrames(
			"translateY(0rem) scale(1)",
			"translateY(-3.75rem) scale(0.92)",
			"back",
			3,
			false,
		);
		expect(frames.map(frame => frame.offset)).toEqual([0, 0.45, 0.45, 1]);
		expect(frames[1]!.zIndex).toBe(104);
		expect(frames[2]!.zIndex).toBe(0);
		expect(frames[1]!.transform).toBe("translate(4%, 72%) rotate(2.5deg) scale(0.97)");
		expect(frames[3]!.transform).toBe("translateY(-3.75rem) scale(0.92)");
	});

	it("brings a card from the back over the deck", () => {
		let frames = shuffleFrames("a", "b", "front", 3, false);
		expect(frames[1]!.zIndex).toBe(0);
		expect(frames[2]!.zIndex).toBe(104);
	});

	it("fades a card that lands deeper than the peeks", () => {
		expect(shuffleFrames("a", "b", "back", 4, true)[3]!.opacity).toBe(0);
	});

	it("eases each half so the layer swap lands at the midpoint in time", () => {
		let frames = shuffleFrames("a", "b", "back", 3, false, "ease-out");
		expect(frames.map(frame => frame.easing)).toEqual([
			"ease-out",
			undefined,
			"ease-out",
			undefined,
		]);
	});
});

describe("moving card", () => {
	it("sends the top card back on next, even in a deck of two", () => {
		expect(movingCard(["a", "b"], ["b", "a"], 1)).toEqual({ id: "a", direction: "back" });
	});

	it("brings the last card forward on previous", () => {
		expect(movingCard(["a", "b", "c"], ["c", "a", "b"], -1))
			.toEqual({ id: "c", direction: "front" });
	});

	it("sends the first card that fell back when settling", () => {
		expect(movingCard(["b", "a", "c"], ["a", "c", "b"])).toEqual({ id: "b", direction: "back" });
		expect(movingCard(["a", "b"], ["a", "b"])).toBeUndefined();
	});
});
