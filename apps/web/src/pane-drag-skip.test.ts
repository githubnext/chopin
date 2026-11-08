import { describe, expect, it } from "bun:test";

import { createPaneDragHold, isNear, skippedSize } from "./pane-drag-skip";

import type { BlockBox, DragHost, SkippableBlock } from "./pane-drag-skip";

/** A block that records what is asked of it, in order, in a log it shares with the host. */
function block(name: string, box: BlockBox | undefined, log: string[]): SkippableBlock {
	return {
		measure: () => (log.push(`measure ${name}`), box),
		skip: size => void log.push(`skip ${name} ${size}`),
		unskip: () => void log.push(`unskip ${name}`),
	};
}

/** A window 1,000 px high, so a block is near from 500 px above it to 500 px below it. */
function page(blocks: (log: string[]) => SkippableBlock[]) {
	let log: string[] = [];
	let found = blocks(log);
	let host: DragHost = {
		blocks: () => found,
		height: () => 1000,
		mark: on => void log.push(on ? "mark on" : "mark off"),
	};
	return { hold: createPaneDragHold(host), log };
}

/** A block of the given height whose top is at `top`, from the top of the window. */
function at(top: number, height = 100, extra: Partial<BlockBox> = {}): BlockBox {
	return { border: 0, height, padding: 0, top, ...extra };
}

describe("the size a skipped block keeps", () => {
	it("is its content box, which is what the stylesheet's intrinsic size describes", () => {
		expect(skippedSize(at(0, 120, { border: 2, padding: 24 }))).toBe(94);
		expect(skippedSize(at(0, 987.25))).toBe(987.25);
	});

	it("never goes below nothing", () => {
		expect(skippedSize(at(0, 6, { border: 4, padding: 8 }))).toBe(0);
	});
});

describe("what is near the window", () => {
	it("is what shows on the window and what is within half its height above or below", () => {
		// A window 1,000 px high: near from -500 to 1,500, measured from its top.
		expect(isNear(at(0, 400), 1000)).toBe(true);
		expect(isNear(at(900, 400), 1000)).toBe(true);
		expect(isNear(at(-300, 200), 1000)).toBe(true);
		expect(isNear(at(1400, 400), 1000)).toBe(true);
	});

	it("is not what lies further off, and a block touching the edge of the margin is out of it", () => {
		expect(isNear(at(-700, 200), 1000)).toBe(false);
		expect(isNear(at(-600, 100), 1000)).toBe(false);
		expect(isNear(at(1500, 100), 1000)).toBe(false);
		expect(isNear(at(3000, 100), 1000)).toBe(false);
	});

	it("is a block that is only partly within the margin, as one that is tall enough to reach it", () => {
		expect(isNear(at(-2000, 2600), 1000)).toBe(true);
		expect(isNear(at(1400, 5000), 1000)).toBe(true);
	});
});

describe("holding a pane drag", () => {
	it("leaves the blocks near the window alone, and keeps only the far ones out", () => {
		let { hold, log } = page(log => [
			block("above", at(-1500, 200), log),
			block("seen", at(300, 400), log),
			block("next", at(1200, 600), log),
			block("below", at(2500, 600), log),
		]);

		hold();

		expect(log).toEqual([
			"measure above",
			"measure seen",
			"measure next",
			"measure below",
			"skip above 200",
			"skip below 600",
			"mark on",
		]);
	});

	it("takes back only what it marked", () => {
		let { hold, log } = page(log => [
			block("seen", at(300, 400), log),
			block("far", at(2500, 600), log),
		]);
		let release = hold();
		log.length = 0;

		release();

		expect(log).toEqual(["mark off", "unskip far"]);
	});

	it("measures every block before it changes any, then marks the page", () => {
		let { hold, log } = page(log => [
			block("a", at(2000, 100), log),
			block("b", at(3000, 52, { border: 2, padding: 10 }), log),
		]);

		hold();

		expect(log).toEqual([
			"measure a",
			"measure b",
			"skip a 100",
			"skip b 40",
			"mark on",
		]);
	});

	it("leaves a block with no box in the flow as it is", () => {
		let { hold, log } = page(log => [
			block("shown", at(2000, 30), log),
			block("absent", undefined, log),
		]);

		hold();

		expect(log).toEqual(["measure shown", "measure absent", "skip shown 30", "mark on"]);
	});

	it("takes the marks back when the drag is over, unmarking the page first", () => {
		let { hold, log } = page(log => [block("a", at(2000, 10), log)]);
		let release = hold();
		log.length = 0;

		release();

		expect(log).toEqual(["mark off", "unskip a"]);
	});

	it("measures once for two drags at a time and lets go with the last", () => {
		let { hold, log } = page(log => [block("a", at(2000, 10), log)]);
		let first = hold();
		let second = hold();
		expect(log).toEqual(["measure a", "skip a 10", "mark on"]);
		log.length = 0;

		first();
		expect(log).toEqual([]);
		second();
		expect(log).toEqual(["mark off", "unskip a"]);
	});

	it("ignores a second release from the same drag", () => {
		let { hold, log } = page(log => [block("a", at(2000, 10), log)]);
		let first = hold();
		let second = hold();
		log.length = 0;

		first();
		first();
		expect(log).toEqual([]);
		second();
		expect(log).toEqual(["mark off", "unskip a"]);
	});

	it("measures again for the next drag, since the page has changed since", () => {
		let heights = [10, 50];
		let log: string[] = [];
		let hold = createPaneDragHold({
			blocks: () => [{
				measure: () => at(2000, heights.shift()!),
				skip: size => void log.push(`skip ${size}`),
				unskip: () => void log.push("unskip"),
			}],
			height: () => 1000,
			mark: () => {},
		});

		hold()();
		hold()();

		expect(log).toEqual(["skip 10", "unskip", "skip 50", "unskip"]);
	});
});
