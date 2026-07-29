/**
 * Marks wait to be seen, then expire.
 *
 * The deferral is the whole feature: the agent writes wherever it likes, and
 * the reader is only shown a mark once it has reached them. What is tested
 * here is that bookkeeping and nothing else — resolving an anchor, finding an
 * element and painting it all need a document, and the test runtime has none.
 */

import { describe, expect, it } from "bun:test";

import { trail } from "./trail";

/** Short enough that a test can wait for it without being slow. */
const LINGER = 20;

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

describe("waiting to be seen", () => {
	it("holds a mark unseen without a clock running", async () => {
		let marks = trail(() => {}, LINGER);
		marks.add(["a"]);

		await sleep(LINGER * 3);

		expect(marks.pending()).toEqual(["a"]);
		expect(marks.showing()).toEqual([]);
	});

	it("starts the clock when a mark is seen", () => {
		let marks = trail(() => {}, LINGER);
		marks.add(["a", "b"]);
		marks.saw(["a"]);

		expect(marks.showing()).toEqual(["a"]);
		expect(marks.pending()).toEqual(["b"]);
	});

	it("takes a mark down once its time is up", async () => {
		let marks = trail(() => {}, LINGER);
		marks.add(["a"]);
		marks.saw(["a"]);

		await sleep(LINGER * 2);

		expect(marks.ids()).toEqual([]);
	});

	/** Nobody asked for this transition, so nobody is watching for it either. */
	it("says when a mark expired on its own", async () => {
		let told = 0;
		let marks = trail(() => told++, LINGER);
		marks.add(["a"]);
		marks.saw(["a"]);

		await sleep(LINGER * 2);

		expect(told).toBe(1);
	});

	/**
	 * The clock is wall time, not attention. A mark that went off screen is
	 * still on its way out — it cannot go dark and light up again later, which
	 * would read as a second edit that never happened.
	 */
	it("keeps counting after a mark scrolls back out of view", async () => {
		let marks = trail(() => {}, LINGER);
		marks.add(["a"]);
		marks.saw(["a"]);
		marks.saw([]);

		await sleep(LINGER * 2);

		expect(marks.ids()).toEqual([]);
	});

	it("does not give a mark more time for being looked at twice", async () => {
		let marks = trail(() => {}, LINGER);
		marks.add(["a"]);
		marks.saw(["a"]);

		await sleep(LINGER * 0.6);
		marks.saw(["a"]);
		await sleep(LINGER * 0.6);

		expect(marks.ids()).toEqual([]);
	});
});

describe("keeping the set bounded", () => {
	it("leaves a mark it already holds alone", () => {
		let marks = trail(() => {}, LINGER);
		marks.add(["a"]);
		marks.saw(["a"]);
		marks.add(["a"]);

		expect(marks.phase("a")).toBe("showing");
	});

	it("drops the oldest unseen marks past the cap", () => {
		let marks = trail(() => {}, LINGER);
		marks.add([...Array(60)].map((_, index) => `m${index}`));

		expect(marks.ids()).toHaveLength(50);
		expect(marks.phase("m0")).toBeUndefined();
		expect(marks.phase("m59")).toBe("pending");
	});

	it("forgets marks that no longer name anywhere", () => {
		let marks = trail(() => {}, LINGER);
		marks.add(["a", "b"]);
		marks.drop(["a"]);

		expect(marks.ids()).toEqual(["b"]);
	});

	it("stops the clock on everything when disposed", async () => {
		let told = 0;
		let marks = trail(() => told++, LINGER);
		marks.add(["a"]);
		marks.saw(["a"]);
		marks.dispose();

		await sleep(LINGER * 2);

		expect(told).toBe(0);
		expect(marks.ids()).toEqual([]);
	});
});
