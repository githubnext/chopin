import { describe, expect, test } from "bun:test";

import { RESTART_QUIET_MS } from "@chopin/protocol/restart";

import {
	CONNECTION_GRACE,
	CONNECTION_STALL,
	connectionGrace,
	connectionNotice,
	countGrace,
	isOffline,
	RESTART_GRACE,
} from "./connection-notice";

describe("connectionNotice", () => {
	test("says nothing while connected or inside the grace period", () => {
		expect(connectionNotice(undefined)).toBe("none");
		expect(connectionNotice(0)).toBe("none");
		expect(connectionNotice(CONNECTION_GRACE - 1)).toBe("none");
	});

	test("reads as reconnecting, then offline once the loss outlasts the stall", () => {
		expect(connectionNotice(CONNECTION_GRACE)).toBe("reconnecting");
		expect(connectionNotice(CONNECTION_GRACE + CONNECTION_STALL - 1)).toBe("reconnecting");
		expect(connectionNotice(CONNECTION_GRACE + CONNECTION_STALL)).toBe("offline");
	});

	test("stays silent longer when the server said it is restarting", () => {
		expect(RESTART_GRACE).toBeGreaterThan(CONNECTION_GRACE);
		// The quiet period, in which the connection reports no outage, and then the ordinary grace.
		expect(RESTART_GRACE).toBe(RESTART_QUIET_MS + CONNECTION_GRACE);
		expect(connectionNotice(CONNECTION_GRACE, true)).toBe("none");
		expect(connectionNotice(RESTART_GRACE - 1, true)).toBe("none");
		expect(connectionNotice(RESTART_GRACE, true)).toBe("reconnecting");
		expect(connectionNotice(RESTART_GRACE + CONNECTION_STALL - 1, true)).toBe("reconnecting");
		expect(connectionNotice(RESTART_GRACE + CONNECTION_STALL, true)).toBe("offline");
	});

	test("names the grace a send held through a blip may wait, the same as the silence", () => {
		expect(connectionGrace()).toBe(CONNECTION_GRACE);
		expect(connectionGrace(false)).toBe(CONNECTION_GRACE);
		expect(connectionGrace(true)).toBe(RESTART_GRACE);
	});

	test("keeps its own grace for a loss the server did not announce", () => {
		expect(connectionNotice(CONNECTION_GRACE, false)).toBe("reconnecting");
		expect(connectionNotice(CONNECTION_GRACE)).toBe("reconnecting");
	});
});

describe("isOffline", () => {
	test("is an outage once a connection that was lost is being re-established", () => {
		expect(isOffline("reconnecting", true)).toBe(true);
		expect(isOffline("connecting", true)).toBe(true);
	});

	test("follows the outage the connection reports, not only its status", () => {
		// A lost connection can read `connected` while the attempt to learn why is still awaited.
		expect(isOffline("connected", true)).toBe(true);
		expect(isOffline("connected", false)).toBe(false);
	});

	test("is not an outage while connected, or on a first connection that is only slow", () => {
		expect(isOffline("connected", false)).toBe(false);
		expect(isOffline("connecting", false)).toBe(false);
		expect(isOffline("reconnecting", false)).toBe(false);
	});

	test("leaves a refusal or a deleted document to say so for itself", () => {
		expect(isOffline("denied", true)).toBe(false);
		expect(isOffline("deleted", true)).toBe(false);
		expect(isOffline("closed", true)).toBe(false);
	});
});

/** A page whose clock, and whether it can be looked at, the test moves. */
function page(visible = true) {
	let now = 0;
	let timers: Array<{ id: number; at: number; callback: () => void }> = [];
	let ids = 0;
	let said: Array<{ at: number; notice: string }> = [];
	let state = { visible };
	let clock = {
		visible: () => state.visible,
		later(callback: () => void, ms: number) {
			let timer = { id: ++ids, at: now + ms, callback };
			timers.push(timer);
			return timer.id;
		},
		cancel(id: unknown) {
			timers = timers.filter(timer => timer.id !== id);
		},
	};
	return {
		clock,
		said,
		/** The loss begins, and the page counts its grace if it can be looked at. */
		lose(restarting = false) {
			return countGrace(clock, restarting, notice => said.push({ at: now, notice }));
		},
		show: (seen: boolean) => void (state.visible = seen),
		/**
		 * A hidden page's timers run once a second, in one tick, whatever fell due since the last, so
		 * time passes here by the tick, as it does in the browser; a visible page runs each when due.
		 */
		pass(ms: number) {
			let until = now + ms;
			while (true) {
				let due = timers.filter(timer => timer.at <= until).toSorted((a, b) => a.at - b.at)[0];
				if (!due) break;
				now = Math.max(now, due.at);
				timers = timers.filter(timer => timer !== due);
				due.callback();
			}
			now = until;
		},
		get now() {
			return now;
		},
	};
}

describe("countGrace", () => {
	test("says reconnecting when the grace has run, then offline, for a page that can be looked at", () => {
		let p = page();
		p.lose();
		p.pass(CONNECTION_GRACE - 1);
		expect(p.said).toEqual([]);
		p.pass(1);
		expect(p.said).toEqual([{ at: CONNECTION_GRACE, notice: "reconnecting" }]);
		p.pass(CONNECTION_STALL);
		expect(p.said.map(said => said.notice)).toEqual(["reconnecting", "offline"]);
	});

	test("does not count the grace of a loss that begins while the page is hidden, however long it lasts", () => {
		let p = page(false);
		p.lose();
		p.pass(CONNECTION_GRACE + CONNECTION_STALL + 60_000);
		expect(p.said).toEqual([]);
	});

	test("says nothing to a hidden page that is frozen, thawed and has its connection back later than the grace, though its hello comes later still", () => {
		let p = page(true);
		let loss = p.lose();
		// Hidden, then frozen: the grace that was running is dropped, and nothing runs while frozen.
		p.pass(200);
		p.show(false);
		loss.look();
		p.pass(3_000);
		// Thawed, still hidden: it learns of the loss and the timers that were due run in one tick.
		loss.look();
		p.pass(CONNECTION_GRACE * 2);
		expect(p.said).toEqual([]);
		// The socket opens, which is the end of the loss, and its hello comes after the grace would have
		// run: the loss is over, so nothing that was counted can say anything now.
		loss.stop();
		p.pass(CONNECTION_GRACE * 3);
		expect(p.said).toEqual([]);
	});

	test("counts the grace whole from when a hidden page is shown while the loss lasts", () => {
		let p = page(false);
		let loss = p.lose();
		p.pass(10_000);
		p.show(true);
		loss.look();
		p.pass(CONNECTION_GRACE - 1);
		expect(p.said).toEqual([]);
		p.pass(1);
		expect(p.said).toEqual([{ at: 10_000 + CONNECTION_GRACE, notice: "reconnecting" }]);
	});

	test("counts the grace again from when a page that is hidden and shown again is, and a loss that ends meanwhile says nothing", () => {
		let p = page(true);
		let loss = p.lose();
		p.pass(CONNECTION_GRACE - 100);
		p.show(false);
		loss.look();
		p.pass(5_000);
		p.show(true);
		loss.look();
		p.pass(CONNECTION_GRACE - 100);
		expect(p.said).toEqual([]);
		loss.stop();
		p.pass(CONNECTION_GRACE * 2);
		expect(p.said).toEqual([]);
	});

	test("leaves a notice that was shown as it is when the page is hidden and shown again", () => {
		let p = page(true);
		let loss = p.lose();
		p.pass(CONNECTION_GRACE);
		expect(p.said.map(said => said.notice)).toEqual(["reconnecting"]);
		p.show(false);
		loss.look();
		p.show(true);
		loss.look();
		p.pass(CONNECTION_STALL);
		// The stall that was running still ends in "offline" on its own time, once.
		expect(p.said.map(said => said.notice)).toEqual(["reconnecting", "offline"]);
	});

	test("keeps the longer silence of a restart for a page that can be looked at", () => {
		let p = page();
		p.lose(true);
		p.pass(RESTART_GRACE - 1);
		expect(p.said).toEqual([]);
		p.pass(1);
		expect(p.said.map(said => said.notice)).toEqual(["reconnecting"]);
	});
});
