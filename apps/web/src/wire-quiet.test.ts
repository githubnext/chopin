/**
 * What a restart's quiet period keeps from `onOutage`, on fake sockets and fake time.
 *
 * The period is five seconds long and what matters is where inside it each thing lands, so it is
 * read from a clock the test moves rather than waited for: a real server would put a knock
 * against the end of the period wherever its timers happened to fall.
 */

import { REFUSAL_HEADER, RESTART_QUIET_MS, SERVICE_RESTART } from "@chopin/protocol/restart";
import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";

import { Wire } from "./wire";

import type { Outage } from "./wire";

/** The part of a browser socket that `Wire` uses, ended and opened by the test. */
class FakeSocket extends EventTarget {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;
	static made: FakeSocket[] = [];

	readyState = FakeSocket.CONNECTING;

	constructor(readonly url: string) {
		super();
		FakeSocket.made.push(this);
	}

	send(): void {}

	close(): void {
		this.readyState = FakeSocket.CLOSED;
	}

	open(): void {
		this.readyState = FakeSocket.OPEN;
		this.dispatchEvent(new Event("open"));
	}

	end(code: number): void {
		this.readyState = FakeSocket.CLOSED;
		this.dispatchEvent(Object.assign(new Event("close"), { code }));
	}
}

let real = {
	WebSocket: globalThis.WebSocket,
	fetch: globalThis.fetch,
	location: globalThis.location,
	random: Math.random,
};
let wires: Wire[] = [];

beforeEach(() => {
	FakeSocket.made = [];
	globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
	// Every probe says the door is not refused, which leaves the retry loop to go on.
	globalThis.fetch = (() =>
		Promise.resolve(new Response(null, { status: 204 }))) as unknown as typeof fetch;
	globalThis.location = { href: "http://chopin.test/", protocol: "http:" } as Location;
	// The least jitter, and the shortest knock, so the timeline below is exact.
	Math.random = () => 0;
	jest.useFakeTimers();
});

afterEach(() => {
	for (let wire of wires) wire.dispose();
	wires = [];
	jest.useRealTimers();
	globalThis.WebSocket = real.WebSocket;
	globalThis.fetch = real.fetch;
	globalThis.location = real.location;
	Math.random = real.random;
});

/** Let the probe's promise settle, which is all a fake `fetch` needs. */
async function settle(): Promise<void> {
	for (let turn = 0; turn < 20; turn++) await Promise.resolve();
}

/** Move the clock on, letting each probe answer as the timers it starts come due. */
async function advance(ms: number): Promise<void> {
	let step = 50;
	for (let moved = 0; moved < ms; moved += step) {
		jest.advanceTimersByTime(Math.min(step, ms - moved));
		await settle();
	}
}

function latest(): FakeSocket {
	return FakeSocket.made.at(-1)!;
}

/** A wire that has connected and then been told, with 1012, that the server is restarting. */
async function restarted(): Promise<{ wire: Wire; outages: Array<Outage | undefined> }> {
	let outages: Array<Outage | undefined> = [];
	let wire = new Wire({
		channelId: "019c1234-1234-4123-8123-123456789abc",
		onOutage: outage => outages.push(outage),
	});
	wires.push(wire);
	latest().open();
	expect(wire.status).toBe("connected");
	latest().end(SERVICE_RESTART);
	await settle();
	expect(wire.restarting).toBe(true);
	return { wire, outages };
}

describe("a restart's quiet period", () => {
	it("raises no outage while it lasts, however many attempts fail in it", async () => {
		let { outages } = await restarted();

		// Each knock the server refuses, from the first attempt to the end of the quiet period.
		for (let waited = 0; waited < RESTART_QUIET_MS - 1_000; waited += 100) {
			await advance(100);
			if (latest().readyState === FakeSocket.CONNECTING) latest().end(1006);
			await settle();
		}
		expect(FakeSocket.made.length).toBeGreaterThan(4);
		expect(outages).toEqual([]);
	});

	it("says nothing at all, not even that an outage ended, when the server is back inside it", async () => {
		let { wire, outages } = await restarted();

		await advance(2_000);
		latest().end(1006);
		await advance(1_000);
		latest().open();

		expect(wire.status).toBe("connected");
		expect(wire.restarting).toBe(false);
		await advance(RESTART_QUIET_MS * 2);
		expect(outages).toEqual([]);
	});

	it("raises the outage when it has passed, though no attempt has failed by then", async () => {
		let { outages } = await restarted();

		// The first attempt is out, neither opened nor refused: nothing but time can end the quiet.
		await advance(RESTART_QUIET_MS - 1);
		expect(latest().readyState).toBe(FakeSocket.CONNECTING);
		expect(outages).toEqual([]);

		await advance(1);
		expect(outages).toEqual([{ failures: 0 }]);
	});

	it("does not count the attempts that failed inside it, and counts those after", async () => {
		let { outages } = await restarted();

		await advance(2_000);
		latest().end(1006);
		await advance(RESTART_QUIET_MS - 2_000);
		// The attempt that followed the failure is still out, and the outage is raised without it.
		expect(outages).toEqual([{ failures: 0 }]);

		latest().end(1006);
		expect(outages).toEqual([{ failures: 0 }, { failures: 1 }]);
	});

	it("goes on as for any other loss once it has passed: the outage ends when the connection opens", async () => {
		let { wire, outages } = await restarted();

		await advance(RESTART_QUIET_MS);
		expect(outages).toEqual([{ failures: 0 }]);

		latest().open();
		expect(wire.status).toBe("connected");
		expect(outages).toEqual([{ failures: 0 }, undefined]);
	});

	it("reports a loss that was not a restart at once, as before", async () => {
		let outages: Array<Outage | undefined> = [];
		let wire = new Wire({
			channelId: "019c1234-1234-4123-8123-123456789abc",
			onOutage: outage => outages.push(outage),
		});
		wires.push(wire);
		latest().open();
		latest().end(1006);

		expect(wire.restarting).toBe(false);
		expect(outages).toEqual([{ failures: 0 }]);
	});

	it("ends at a refusal: no outage is raised afterwards, and the restart is over", async () => {
		let { wire, outages } = await restarted();

		globalThis.fetch = (() =>
			Promise.resolve(
				new Response("Not allowed", { status: 403, headers: { [REFUSAL_HEADER]: "1" } }),
			)) as unknown as typeof fetch;
		await advance(1_000);
		latest().end(1006);
		await settle();

		expect(wire.status).toBe("denied");
		expect(wire.restarting).toBe(false);
		await advance(RESTART_QUIET_MS * 2);
		expect(outages).toEqual([]);
	});

	it("is not raised for a wire that was disposed during it", async () => {
		let { wire, outages } = await restarted();

		wire.dispose();
		await advance(RESTART_QUIET_MS * 2);
		expect(outages).toEqual([]);
	});
});
