import { describe, expect, it } from "bun:test";
import { TypingReporter } from "./typing";

function fixture() {
	let now = 0;
	let events: { active: boolean; at: number }[] = [];
	let timers = new Map<object, { at: number; callback: () => void }>();
	let reporter = new TypingReporter(active => events.push({ active, at: now }), {
		now: () => now,
		after: (callback, delay) => {
			let key = {};
			timers.set(key, { at: now + delay, callback });
			return () => timers.delete(key);
		},
	});
	let advance = (milliseconds: number) => {
		let end = now + milliseconds;
		while (true) {
			let next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
			if (!next || next[1].at > end) break;
			now = next[1].at;
			timers.delete(next[0]);
			next[1].callback();
		}
		now = end;
	};
	return { reporter, events, advance, timers };
}

describe("composer typing lease", () => {
	it("reports the first edit and throttles renewal during continuous edits", () => {
		let { reporter, events, advance } = fixture();
		expect(events).toEqual([]);
		reporter.change();
		advance(1000);
		reporter.change();
		advance(999);
		reporter.change();
		expect(events).toEqual([{ active: true, at: 0 }]);
		advance(1);
		reporter.change();
		expect(events).toEqual([{ active: true, at: 0 }, { active: true, at: 2000 }]);
	});

	it("ends the lease 2.5 seconds after the latest edit", () => {
		let { reporter, events, advance, timers } = fixture();
		reporter.change();
		advance(2000);
		reporter.change();
		advance(2499);
		expect(events.at(-1)).toEqual({ active: true, at: 2000 });
		advance(1);
		expect(events.at(-1)).toEqual({ active: false, at: 4500 });
		expect(timers.size).toBe(0);
	});

	it("stops immediately and cancels the idle timer for blur, send, or disposal", () => {
		let { reporter, events, advance, timers } = fixture();
		reporter.change();
		advance(25);
		reporter.stop();
		reporter.stop();
		advance(10000);
		expect(events).toEqual([{ active: true, at: 0 }, { active: false, at: 25 }]);
		expect(timers.size).toBe(0);
	});

	it("stays quiet until another actual edit starts a new lease", () => {
		let { reporter, events, advance } = fixture();
		reporter.stop();
		advance(10000);
		expect(events).toEqual([]);
		reporter.change();
		advance(2500);
		advance(2000);
		expect(events.at(-1)).toEqual({ active: false, at: 12500 });
		reporter.change();
		expect(events.at(-1)).toEqual({ active: true, at: 14500 });
	});
});
