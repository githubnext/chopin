import { expect, test } from "bun:test";

import { LONG_PRESS_MS, LONG_PRESS_SLOP, LongPress } from "./long-press";

function clock() {
	let timers = new Map<number, { at: number; callback: () => void }>();
	let now = 0;
	let next = 1;
	return {
		set: (callback: () => void, ms: number) => {
			timers.set(next, { at: now + ms, callback });
			return next++;
		},
		clear: (handle: unknown) => void timers.delete(handle as number),
		advance(ms: number) {
			now += ms;
			for (let [id, timer] of timers) {
				if (timer.at <= now) {
					timers.delete(id);
					timer.callback();
				}
			}
		},
		pending: () => timers.size,
	};
}

test("a touch held still for the whole delay is a long press", () => {
	let time = clock();
	let presses = 0;
	let press = new LongPress(() => presses++, time);
	press.start(10, 10);
	time.advance(LONG_PRESS_MS - 1);
	expect(presses).toBe(0);
	time.advance(1);
	expect(presses).toBe(1);
	expect(press.fired).toBe(true);
	expect(press.end()).toBe(true);
	expect(press.fired).toBe(false);
});

test("a tap that ends first is not one", () => {
	let time = clock();
	let presses = 0;
	let press = new LongPress(() => presses++, time);
	press.start(0, 0);
	time.advance(LONG_PRESS_MS - 100);
	expect(press.end()).toBe(false);
	time.advance(1000);
	expect(presses).toBe(0);
	expect(time.pending()).toBe(0);
});

test("a finger that moves past the slop is scrolling, one within it is still holding", () => {
	let time = clock();
	let presses = 0;
	let press = new LongPress(() => presses++, time);
	press.start(0, 0);
	press.move(LONG_PRESS_SLOP, 0);
	time.advance(LONG_PRESS_MS);
	expect(presses).toBe(1);
	press.end();

	press.start(0, 0);
	press.move(LONG_PRESS_SLOP + 1, 0);
	time.advance(LONG_PRESS_MS * 2);
	expect(presses).toBe(1);
});

test("a new touch cancels the one before it", () => {
	let time = clock();
	let presses = 0;
	let press = new LongPress(() => presses++, time);
	press.start(0, 0);
	time.advance(LONG_PRESS_MS - 10);
	press.start(0, 0);
	time.advance(20);
	expect(presses).toBe(0);
	time.advance(LONG_PRESS_MS);
	expect(presses).toBe(1);
});
