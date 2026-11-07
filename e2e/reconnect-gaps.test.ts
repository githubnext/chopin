import { describe, expect, it } from "bun:test";

import { reconnectGaps, reconnectProblems } from "./reconnect-gaps";

import type { SocketEvent } from "./reconnect-gaps";

const ROOT = "/ws?channel=root";
const CHILD = "/ws?channel=child";
const LIMIT_MS = 1_500;

const hello = (at: number, key: string): SocketEvent => ({ at, key, kind: "hello" });
const cut = (at: number, key: string): SocketEvent => ({ at, key, kind: "cut" });
const open = (at: number, key: string): SocketEvent => ({ at, key, kind: "open" });
const restarting = (at: number, key: string): SocketEvent => ({ at, key, kind: "restarting" });

describe("the gap a tab's sockets show across a hand-over", () => {
	it("is each socket's own, so a slow one is not hidden behind a quick one that closed after it", () => {
		// The root closes first and opens last, the child closes after it and opens at once: pairing
		// each open with the oldest close would give the root's open to the child's close.
		let events = [
			cut(0, ROOT),
			cut(100, CHILD),
			open(250, CHILD),
			open(1_600, ROOT),
		];
		let gaps = reconnectGaps(events);
		expect(gaps.find(gap => gap.key === ROOT)?.closeToOpenMs).toBe(1_600);
		expect(gaps.find(gap => gap.key === CHILD)?.closeToOpenMs).toBe(150);
		expect(reconnectProblems(gaps, LIMIT_MS)).toEqual([
			`${ROOT}: opened again 1600 ms after it closed, over the ${LIMIT_MS} ms allowed`,
		]);
	});

	it("is the slowest of sockets that cannot be told apart, whichever of them opened first", () => {
		let gaps = reconnectGaps([
			cut(0, ROOT),
			cut(100, ROOT),
			open(250, ROOT),
			open(1_600, ROOT),
		]);
		expect(gaps).toHaveLength(1);
		expect(gaps[0]!.closeToOpenMs).toBe(1_600);
		expect(reconnectProblems(gaps, LIMIT_MS)).toHaveLength(1);
	});

	it("passes when every socket is back within the limit, and counts only what opened after the cut", () => {
		let events = [
			open(0, ROOT),
			open(5, CHILD),
			hello(10, ROOT),
			restarting(2_000, ROOT),
			restarting(2_001, CHILD),
			cut(2_002, ROOT),
			cut(2_003, CHILD),
			open(2_900, CHILD),
			open(3_400, ROOT),
			hello(3_450, ROOT),
		];
		let gaps = reconnectGaps(events);
		expect(gaps.find(gap => gap.key === ROOT)).toMatchObject({
			closeToOpenMs: 1_398,
			restartToHelloMs: 1_450,
		});
		expect(gaps.find(gap => gap.key === CHILD)).toMatchObject({ closeToOpenMs: 897 });
		expect(reconnectProblems(gaps, LIMIT_MS)).toEqual([]);
	});

	it("fails a socket that never opened again, and a socket that opened but whose hello is slow or never came", () => {
		let gone = reconnectGaps([cut(0, ROOT)]);
		expect(reconnectProblems(gone, LIMIT_MS)).toEqual([
			`${ROOT}: closed 1 time(s) and opened again 0`,
		]);

		let slow = reconnectGaps([
			hello(0, ROOT),
			restarting(10, ROOT),
			cut(11, ROOT),
			open(300, ROOT),
			hello(1_800, ROOT),
		]);
		expect(reconnectProblems(slow, LIMIT_MS)).toEqual([
			`${ROOT}: hello came 1790 ms after the restart frame, over the ${LIMIT_MS} ms allowed`,
		]);

		let silent = reconnectGaps([
			hello(0, ROOT),
			restarting(10, ROOT),
			cut(11, ROOT),
			open(300, ROOT),
		]);
		expect(reconnectProblems(silent, LIMIT_MS)).toEqual([
			`${ROOT}: 1 restart frame(s) and 0 hello(s) after them`,
		]);
	});

	it("asks no hello of a socket that never said one, such as the sidebar's", () => {
		let gaps = reconnectGaps([
			restarting(10, "/ws/sidebar?"),
			cut(11, "/ws/sidebar?"),
			open(300, "/ws/sidebar?"),
		]);
		expect(reconnectProblems(gaps, LIMIT_MS)).toEqual([]);
	});

	it("is nothing at all when no socket was cut", () => {
		expect(reconnectGaps([open(0, ROOT), hello(5, ROOT)])).toEqual([]);
	});
});
