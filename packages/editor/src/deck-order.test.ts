import { describe, expect, it } from "bun:test";

import { arrange, bringForward, cycle, position, settle, slot } from "./deck-order";

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
