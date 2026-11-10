import { expect, test } from "bun:test";

import { CopyConfirmation } from "./use-copy-to-clipboard";

import type { Confirmation } from "./use-copy-to-clipboard";

function clock() {
	let now = 0;
	let next = 0;
	let pending = new Map<number, { at: number; callback: () => void }>();
	return {
		timers: {
			set: (callback: () => void, ms: number) => {
				pending.set(++next, { at: now + ms, callback });
				return next;
			},
			clear: (handle: unknown) => {
				pending.delete(handle as number);
			},
		},
		advance(ms: number) {
			now += ms;
			for (let [handle, timer] of pending) {
				if (timer.at > now) continue;
				pending.delete(handle);
				timer.callback();
			}
		},
		get waiting() {
			return pending.size;
		},
	};
}

function confirmation() {
	let time = clock();
	let seen: Confirmation[] = [];
	let copy = new CopyConfirmation(state => seen.push(state), time.timers);
	return { copy, time, seen };
}

test("a copy the clipboard accepted says copied until its duration is over", () => {
	let { copy, time } = confirmation();
	copy.begin();
	copy.copied(1500);
	expect(copy.state).toEqual({ copied: true, failed: false });
	time.advance(1499);
	expect(copy.state.copied).toBe(true);
	time.advance(1);
	expect(copy.state).toEqual({ copied: false, failed: false });
});

test("a copy the clipboard refused says failed, and only failed, until its duration is over", () => {
	let { copy, time } = confirmation();
	copy.begin();
	copy.refused(1500);
	expect(copy.state).toEqual({ copied: false, failed: true });
	time.advance(1500);
	expect(copy.state).toEqual({ copied: false, failed: false });
});

test("a copy refused while the one before still says copied takes that back and leaves no timer to say it again", () => {
	let { copy, time, seen } = confirmation();
	copy.begin();
	copy.copied(1500);
	time.advance(400);
	copy.begin();
	expect(copy.state).toEqual({ copied: true, failed: false });
	copy.refused(1500);
	expect(copy.state).toEqual({ copied: false, failed: true });
	expect(seen.at(-1)).toEqual({ copied: false, failed: true });
	expect(time.waiting).toBe(1);
	time.advance(1100);
	expect(copy.state).toEqual({ copied: false, failed: true });
	time.advance(400);
	expect(copy.state).toEqual({ copied: false, failed: false });
	expect(time.waiting).toBe(0);
});

test("a copy accepted after a refusal replaces the refusal", () => {
	let { copy, time } = confirmation();
	copy.begin();
	copy.refused(1500);
	copy.begin();
	expect(copy.state).toEqual({ copied: false, failed: false });
	copy.copied(1500);
	expect(copy.state).toEqual({ copied: true, failed: false });
	time.advance(1500);
	expect(copy.state).toEqual({ copied: false, failed: false });
});

test("a second accepted copy starts its duration again", () => {
	let { copy, time } = confirmation();
	copy.copied(1500);
	time.advance(1000);
	copy.copied(1500);
	time.advance(1000);
	expect(copy.state.copied).toBe(true);
	time.advance(500);
	expect(copy.state.copied).toBe(false);
});

test("stopping clears what is shown and every timer", () => {
	let { copy, time } = confirmation();
	copy.copied(1500);
	copy.refused(1500);
	copy.copied(1500);
	copy.stop();
	expect(copy.state).toEqual({ copied: false, failed: false });
	expect(time.waiting).toBe(0);
});
