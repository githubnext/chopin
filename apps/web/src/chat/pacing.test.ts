import { describe, expect, it } from "bun:test";
import { PacingReporter } from "./pacing";
import { TypingReporter } from "./typing";

function timers() {
	let now = 0;
	let pending = new Map<object, { at: number; callback: () => void }>();
	let clock = {
		now: () => now,
		after: (callback: () => void, delay: number) => {
			let key = {};
			pending.set(key, { at: now + delay, callback });
			return () => pending.delete(key);
		},
	};
	let advance = (milliseconds: number) => {
		let end = now + milliseconds;
		while (true) {
			let next = [...pending].sort((a, b) => a[1].at - b[1].at)[0];
			if (!next || next[1].at > end) break;
			now = next[1].at;
			pending.delete(next[0]);
			next[1].callback();
		}
		now = end;
	};
	return { clock, advance, pending, at: () => now };
}

function fixture() {
	let time = timers();
	let events: { active: boolean; at: number }[] = [];
	let reporter = new PacingReporter(
		active => events.push({ active, at: time.at() }),
		time.clock,
	);
	return { reporter, events, advance: time.advance, timers: time.pending };
}

describe("composer pacing for automatic participation", () => {
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

	it("ends 2.5 seconds after the latest edit", () => {
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

	it("keeps its own pace while the typing line holds a person for five seconds", () => {
		let time = timers();
		let activity: { active: boolean; at: number }[] = [];
		let shown: { active: boolean; at: number }[] = [];
		let pacing = new PacingReporter(
			active => activity.push({ active, at: time.at() }),
			time.clock,
		);
		let display = new TypingReporter(
			report => shown.push({ active: report.active, at: time.at() }),
			time.clock,
		);
		pacing.change();
		display.change();
		time.advance(10_000);
		expect(activity).toEqual([{ active: true, at: 0 }, { active: false, at: 2500 }]);
		expect(shown).toEqual([{ active: true, at: 0 }, { active: false, at: 5000 }]);
	});
});
