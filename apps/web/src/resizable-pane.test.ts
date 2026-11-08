import { describe, expect, it } from "bun:test";

import {
	clampPane,
	keyboardPaneDelta,
	readPaneWidth,
	resizeDelta,
	restorePaneWidth,
	startPaneDrag,
	writePaneWidth,
} from "./resizable-pane";

import type { PaneFrames } from "./resizable-pane";

/** Animation frames that run only when the test says a frame has come. */
function frames() {
	let queue = new Map<number, () => void>();
	let next = 1;
	let scheduler: PaneFrames = {
		request: callback => {
			queue.set(next, callback);
			return next++;
		},
		cancel: handle => void queue.delete(handle),
	};
	return {
		scheduler,
		waiting: () => queue.size,
		frame: () => {
			let due = [...queue.values()];
			queue.clear();
			for (let callback of due) callback();
		},
	};
}

function drag(start: number, bounds = { min: 250, max: 400 }, held = false) {
	let clock = frames();
	let shown: number[] = [];
	let committed: number[] = [];
	let order: string[] = [];
	let pane = startPaneDrag({
		begin: held ? () => (order.push("begin"), () => order.push("finish")) : undefined,
		bounds: () => bounds,
		commit: width => (committed.push(width), order.push("commit")),
		frames: clock.scheduler,
		release: () => order.push("release"),
		show: width => shown.push(width),
		width: start,
	});
	return { ...clock, bounds, committed, order, pane, shown };
}

describe("bounded pane resizing", () => {
	it("keeps a pane width within its inclusive bounds", () => {
		expect(clampPane(249, 250, 400)).toBe(250);
		expect(clampPane(304, 304, 400)).toBe(304);
		expect(clampPane(401, 250, 400)).toBe(400);
	});

	it("keeps each pane edge under the pointer", () => {
		expect(resizeDelta("left", -16)).toBe(16);
		expect(resizeDelta("left", 16)).toBe(-16);
		expect(resizeDelta("right", 16)).toBe(16);
		expect(resizeDelta("right", -16)).toBe(-16);
	});

	it("restores a valid saved width and rejects invalid persisted values", () => {
		let bounds = { initial: 304, min: 304, max: 400 };

		expect(restorePaneWidth("360", bounds)).toBe(360);
		expect(restorePaneWidth("800", bounds)).toBe(400);
		expect(restorePaneWidth("bad", bounds)).toBe(304);
		expect(restorePaneWidth(null, bounds)).toBe(304);
	});

	it("does not read or write shared storage for an isolated pane", () => {
		let reads: string[] = [];
		let writes: Array<[string, string]> = [];
		let storage = {
			getItem(key: string) {
				reads.push(key);
				return "360";
			},
			setItem(key: string, value: string) {
				writes.push([key, value]);
			},
		};
		let bounds = { initial: 304, min: 304, max: 400 };

		expect(readPaneWidth(storage, undefined, bounds)).toBe(304);
		writePaneWidth(storage, undefined, 320);
		expect(reads).toEqual([]);
		expect(writes).toEqual([]);

		expect(readPaneWidth(storage, "chopin:pane:chat", bounds)).toBe(360);
		writePaneWidth(storage, "chopin:pane:chat", 320);
		expect(reads).toEqual(["chopin:pane:chat"]);
		expect(writes).toEqual([["chopin:pane:chat", "320"]]);
	});

	it("maps keyboard commands to bounded pane movements", () => {
		let bounds = { min: 304, max: 400 };

		expect(keyboardPaneDelta("left", "ArrowLeft", false, 320, bounds)).toBe(16);
		expect(keyboardPaneDelta("left", "ArrowRight", true, 384, bounds)).toBe(-64);
		expect(keyboardPaneDelta("right", "ArrowRight", false, 320, bounds)).toBe(16);
		expect(keyboardPaneDelta("right", "ArrowLeft", true, 384, bounds)).toBe(-64);
		expect(keyboardPaneDelta("left", "Home", false, 360, bounds)).toBe(-56);
		expect(keyboardPaneDelta("right", "End", false, 360, bounds)).toBe(40);
		expect(keyboardPaneDelta("left", "Tab", false, 360, bounds)).toBeUndefined();
	});
});

describe("dragging a pane edge", () => {
	it("shows the width once per frame however many moves the frame holds, and commits once at the end", () => {
		let { committed, frame, pane, shown } = drag(300);

		pane.move(5);
		pane.move(5);
		pane.move(5);
		expect(shown).toEqual([]);
		frame();
		expect(shown).toEqual([315]);

		pane.move(-5);
		pane.move(20);
		frame();
		frame();
		expect(shown).toEqual([315, 330]);
		expect(committed).toEqual([]);

		pane.end();
		expect(shown).toEqual([315, 330]);
		expect(committed).toEqual([330]);
	});

	it("takes back what it showed only after the width is committed", () => {
		let { frame, order, pane } = drag(300);

		pane.move(25);
		frame();
		expect(order).toEqual([]);
		pane.end();

		expect(order).toEqual(["commit", "release"]);
	});

	it("clamps every move on its own, so overshooting a bound and coming back is not summed away", () => {
		let { frame, pane, shown } = drag(390);

		pane.move(30);
		pane.move(-20);
		frame();

		// 390 + 30 stops at 400, and the way back is 20 from there. Summed first, it would be 400.
		expect(shown).toEqual([380]);
	});

	it("shows what the last move asked for before it commits, when the pointer is released mid-frame", () => {
		let { committed, pane, shown, waiting } = drag(300);

		pane.move(40);
		expect(waiting()).toBe(1);
		pane.end();

		expect(shown).toEqual([340]);
		expect(committed).toEqual([340]);
		expect(waiting()).toBe(0);
	});

	it("commits nothing, but still lets go, for a press that never moved or came back to where it began", () => {
		let still = drag(300);
		still.pane.end();
		expect(still.committed).toEqual([]);
		expect(still.shown).toEqual([]);
		expect(still.order).toEqual(["release"]);

		let back = drag(300);
		back.pane.move(25);
		back.frame();
		back.pane.move(-25);
		back.pane.end();
		// It was shown 25 px wider on the way, so what it showed is taken back, not committed.
		expect(back.shown).toEqual([325, 300]);
		expect(back.committed).toEqual([]);
		expect(back.order).toEqual(["release"]);
		expect(back.waiting()).toBe(0);
	});

	it("ends once: a second release, and a move after it, change nothing", () => {
		let { committed, frame, order, pane, shown, waiting } = drag(300);

		pane.move(10);
		pane.end();
		pane.end();
		pane.cancel();
		pane.move(10);
		frame();

		expect(committed).toEqual([310]);
		expect(shown).toEqual([310]);
		expect(order).toEqual(["commit", "release"]);
		expect(waiting()).toBe(0);
	});

	it("drops a pending frame and commits nothing when the handle goes away mid-drag", () => {
		let { committed, frame, order, pane, shown, waiting } = drag(300);

		pane.move(10);
		pane.cancel();
		frame();

		expect(waiting()).toBe(0);
		expect(shown).toEqual([]);
		expect(committed).toEqual([]);
		expect(order).toEqual(["release"]);
	});

	it("begins when the first width is shown, never for a press that does not move the edge, and finishes after releasing", () => {
		let moved = drag(300, undefined, true);
		moved.pane.move(10);
		expect(moved.order).toEqual([]);
		moved.frame();
		moved.pane.move(10);
		moved.frame();
		expect(moved.order).toEqual(["begin"]);
		moved.pane.end();
		expect(moved.order).toEqual(["begin", "commit", "release", "finish"]);

		let still = drag(300, undefined, true);
		still.pane.end();
		expect(still.order).toEqual(["release"]);

		let netted = drag(300, undefined, true);
		netted.pane.move(10);
		netted.pane.move(-10);
		netted.frame();
		netted.pane.end();
		// The pointer came back inside one frame, so nothing was ever shown.
		expect(netted.order).toEqual(["release"]);
	});

	it("finishes a drag that the browser takes away, and does so once", () => {
		let { frame, order, pane } = drag(300, undefined, true);

		pane.move(10);
		frame();
		pane.cancel();
		pane.end();
		pane.cancel();

		expect(order).toEqual(["begin", "release", "finish"]);
	});

	it("finishes a drag that came back to where it began, which commits nothing", () => {
		let { committed, frame, order, pane } = drag(300, undefined, true);

		pane.move(25);
		frame();
		pane.move(-25);
		pane.end();

		expect(committed).toEqual([]);
		expect(order).toEqual(["begin", "release", "finish"]);
	});

	it("reads the bounds on every move, so a window that narrows mid-drag moves the maximum", () => {
		let { bounds, frame, pane, shown } = drag(380);

		pane.move(20);
		frame();
		bounds.max = 350;
		pane.move(-5);
		frame();

		expect(shown).toEqual([400, 350]);
	});
});
