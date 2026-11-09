import { expect, test } from "bun:test";

import { NEAR_MARGIN, watchNear, watchPlaced } from "./near-viewport";

/** A browser's observer, told by the test what is in view. */
function fakeObserver() {
	let made: {
		callback: (entries: { isIntersecting: boolean }[]) => void;
		options: { root: Element | null; rootMargin: string };
		observed: unknown[];
		disconnected: number;
	}[] = [];
	class Fake {
		state: (typeof made)[number];
		constructor(
			callback: (entries: { isIntersecting: boolean }[]) => void,
			options: { root: Element | null; rootMargin: string },
		) {
			this.state = { callback, options, observed: [], disconnected: 0 };
			made.push(this.state);
		}
		observe(target: unknown) {
			this.state.observed.push(target);
		}
		disconnect() {
			this.state.disconnected++;
		}
	}
	return { made, Fake };
}

let target = {} as Element;
let scroller = {} as Element;

test("a block is not near while it is more than a screen out of its scroller's view", () => {
	let { made, Fake } = fakeObserver();
	let near = 0;
	watchNear(target, scroller, () => near++, Fake);
	made[0]!.callback([{ isIntersecting: false }]);
	expect(near).toBe(0);
	// It watches the block from the scroller it sits in, a screen out either way and no further.
	expect(made[0]!.observed).toEqual([target]);
	expect(made[0]!.options).toEqual({ root: scroller, rootMargin: NEAR_MARGIN });
	expect(NEAR_MARGIN).toBe("100% 0px");
});

test("a block that comes near is reported once and then no longer watched", () => {
	let { made, Fake } = fakeObserver();
	let near = 0;
	watchNear(target, scroller, () => near++, Fake);
	made[0]!.callback([{ isIntersecting: false }]);
	made[0]!.callback([{ isIntersecting: true }]);
	made[0]!.callback([{ isIntersecting: true }]);
	expect(near).toBe(1);
	expect(made[0]!.disconnected).toBeGreaterThanOrEqual(1);
});

test("one entry among several that is in view is enough", () => {
	let { made, Fake } = fakeObserver();
	let near = 0;
	watchNear(target, scroller, () => near++, Fake);
	made[0]!.callback([{ isIntersecting: false }, { isIntersecting: true }]);
	expect(near).toBe(1);
});

test("the caller ends a watch by leaving, and a block that never came near is never reported", () => {
	let { made, Fake } = fakeObserver();
	let near = 0;
	let stop = watchNear(target, scroller, () => near++, Fake);
	stop();
	expect(made[0]!.disconnected).toBe(1);
	expect(near).toBe(0);
});

test("where the browser cannot say what is in view, every block counts as near", () => {
	let near = 0;
	let stop = watchNear(target, scroller, () => near++, undefined);
	expect(near).toBe(1);
	stop();
});

test("a block's place is told once, whichever side of the margin it is on, and then no longer watched", () => {
	let { made, Fake } = fakeObserver();
	let told: boolean[] = [];
	watchPlaced(target, scroller, near => told.push(near), Fake);
	expect(made[0]!.observed).toEqual([target]);
	expect(made[0]!.options).toEqual({ root: scroller, rootMargin: NEAR_MARGIN });
	// The browser's first report is the block's place at mount: here, a long way out.
	made[0]!.callback([{ isIntersecting: false }]);
	made[0]!.callback([{ isIntersecting: true }]);
	expect(told).toEqual([false]);
	expect(made[0]!.disconnected).toBeGreaterThanOrEqual(1);
	// The same for a block that is near.
	let near = fakeObserver();
	let nearTold: boolean[] = [];
	watchPlaced(target, scroller, value => nearTold.push(value), near.Fake);
	near.made[0]!.callback([{ isIntersecting: false }, { isIntersecting: true }]);
	expect(nearTold).toEqual([true]);
});

test("the caller ends a watch of a block's place by leaving, and nothing is told after", () => {
	let { made, Fake } = fakeObserver();
	let told: boolean[] = [];
	let stop = watchPlaced(target, scroller, near => told.push(near), Fake);
	stop();
	expect(made[0]!.disconnected).toBe(1);
	expect(told).toEqual([]);
});

test("where the browser cannot say what is in view, a block's place is near", () => {
	let told: boolean[] = [];
	watchPlaced(target, scroller, near => told.push(near), undefined);
	expect(told).toEqual([true]);
});
