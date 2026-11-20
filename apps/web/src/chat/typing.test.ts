import { describe, expect, it } from "bun:test";
import { TypingReporter } from "./typing";

import type { TypingReport } from "./typing";

function fixture() {
	let now = 0;
	let reports: Array<TypingReport & { at: number }> = [];
	let timers = new Map<object, { at: number; callback: () => void }>();
	let reporter = new TypingReporter(report => reports.push({ ...report, at: now }), {
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
	let told = () => reports.map(({ seq: _seq, ...rest }) => rest);
	return { reporter, reports, told, advance, timers };
}

describe("composer typing reports", () => {
	it("reports the first edit at once and one edit of every two seconds after", () => {
		let { reporter, told, advance } = fixture();
		expect(told()).toEqual([]);
		reporter.change();
		advance(1000);
		reporter.change();
		advance(500);
		reporter.change();
		expect(told()).toEqual([{ active: true, ago: 0, at: 0 }]);
		advance(500);
		expect(told()).toEqual([{ active: true, ago: 0, at: 0 }, { active: true, ago: 500, at: 2000 }]);
	});

	it("ends five seconds after the last edit, not after the last report", () => {
		let { reporter, told, advance, timers } = fixture();
		reporter.change();
		advance(1500);
		reporter.change();
		advance(4999);
		expect(told()).toEqual([
			{ active: true, ago: 0, at: 0 },
			{ active: true, ago: 500, at: 2000 },
		]);
		advance(1);
		expect(told().at(-1)).toEqual({ active: false, at: 6500 });
		expect(timers.size).toBe(0);
	});

	it("a single edit sends one start and exactly one stop, at five seconds", () => {
		let { reporter, told, advance } = fixture();
		reporter.change();
		advance(4999);
		expect(told()).toHaveLength(1);
		advance(1);
		expect(told()).toEqual([{ active: true, ago: 0, at: 0 }, { active: false, at: 5000 }]);
		advance(20_000);
		expect(told()).toHaveLength(2);
	});

	it("an edit after the last report is told before its stop, so no lease lapses first", () => {
		let { reporter, told, advance } = fixture();
		reporter.change();
		advance(1999);
		reporter.change();
		advance(10_000);
		let reports = told();
		let stop = reports.findIndex(report => !report.active);
		let last = reports[stop - 1]!;
		expect(last).toMatchObject({ active: true, ago: 1, at: 2000 });
		expect(reports[stop]!.at - (last.at - (last.active ? last.ago : 0))).toBe(5000);
	});

	it("stops at once and cancels its timers for blur, send, a cleared draft or disposal", () => {
		let { reporter, told, advance, timers } = fixture();
		reporter.change();
		advance(25);
		reporter.stop();
		reporter.stop();
		advance(10000);
		expect(told()).toEqual([{ active: true, ago: 0, at: 0 }, { active: false, at: 25 }]);
		expect(timers.size).toBe(0);
	});

	it("turned on and off quickly, sends at most one start and one stop every two seconds", () => {
		let { reporter, told, advance } = fixture();
		reporter.change();
		advance(50);
		reporter.stop();
		advance(50);
		reporter.change();
		advance(50);
		reporter.stop();
		advance(50);
		reporter.change();
		expect(told()).toEqual([{ active: true, ago: 0, at: 0 }, { active: false, at: 50 }]);
		advance(1800);
		expect(told()).toEqual([
			{ active: true, ago: 0, at: 0 },
			{ active: false, at: 50 },
			{ active: true, ago: 1800, at: 2000 },
		]);
	});

	it("a start and stop that both fall inside the wait send nothing", () => {
		let { reporter, told, advance } = fixture();
		reporter.change();
		reporter.stop();
		advance(100);
		reporter.change();
		advance(100);
		reporter.stop();
		advance(10_000);
		expect(told()).toEqual([{ active: true, ago: 0, at: 0 }, { active: false, at: 0 }]);
	});

	it("numbers every report after the one before, across composers", () => {
		let first = fixture();
		let second = fixture();
		first.reporter.change();
		second.reporter.change();
		first.reporter.stop();
		let numbers = [first.reports[0]!.seq, second.reports[0]!.seq, first.reports[1]!.seq];
		expect(numbers).toEqual(numbers.toSorted((a, b) => a - b));
		expect(new Set(numbers).size).toBe(3);
	});

	it("stays quiet until another actual edit starts it again", () => {
		let { reporter, told, advance } = fixture();
		reporter.stop();
		advance(10000);
		expect(told()).toEqual([]);
		reporter.change();
		advance(5000);
		expect(told().at(-1)).toEqual({ active: false, at: 15000 });
		advance(2000);
		reporter.change();
		expect(told().at(-1)).toEqual({ active: true, ago: 0, at: 17000 });
	});
});
