import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";

import { WriterLease } from "./writer-lease";

import type { Lease } from "./model";
import type { LeaseStore } from "./port";

function lease(): Lease {
	return { name: "chopin:writer", owner: "writer", fencing: 1, expiresAt: new Date() };
}

function leases(renew: LeaseStore["renew"]): LeaseStore {
	return {
		peek: async () => undefined,
		acquire: async () => undefined,
		renew,
		release: async () => true,
	};
}

describe("WriterLease", () => {
	let quiet: ReturnType<typeof spyOn>[] = [];
	beforeEach(() => {
		quiet = [
			spyOn(console, "error").mockImplementation(() => {}),
			spyOn(console, "warn").mockImplementation(() => {}),
		];
	});
	afterEach(() => {
		for (let spy of quiet) spy.mockRestore();
	});

	it("holds the lease only while it is held, before its deadline and until it is stopped to be released", async () => {
		let writer = new WriterLease(
			leases(async () => undefined),
			{ ttlMs: 80, renewMs: 1_000, safetyMs: 20, retryMs: 1_000 },
			() => {},
		);
		expect(writer.holds()).toBe(false);
		writer.hold(lease());
		expect(writer.holds()).toBe(true);
		await Bun.sleep(70);
		expect(writer.holds()).toBe(false);

		writer.hold(lease());
		expect(writer.holds()).toBe(true);
		await writer.stop();
		expect(writer.held).toBeDefined();
		expect(writer.holds()).toBe(false);
	});

	it("does not arm a new safety deadline when a renewal succeeds after stopping", async () => {
		let renewal = Promise.withResolvers<Lease | undefined>();
		let sent = Promise.withResolvers<void>();
		let lost = 0;
		let writer = new WriterLease(
			leases(() => {
				sent.resolve();
				return renewal.promise;
			}),
			{ ttlMs: 80, renewMs: 10, safetyMs: 20, retryMs: 10 },
			() => lost++,
		);
		writer.hold(lease());
		writer.start();
		await sent.promise;

		let stopping = writer.stop();
		renewal.resolve(lease());
		await stopping;
		await Bun.sleep(160);

		expect(lost).toBe(0);
		expect(writer.held).toBeDefined();
	});

	it("makes no further renewal attempt once stopped while a failed renewal waits to retry", async () => {
		let attempts = 0;
		let failed = Promise.withResolvers<void>();
		let writer = new WriterLease(
			leases(async () => {
				attempts++;
				failed.resolve();
				throw new Error("unavailable");
			}),
			{ ttlMs: 1_000, renewMs: 20, safetyMs: 100, retryMs: 30 },
			() => {},
		);
		writer.hold(lease());
		writer.start();
		await failed.promise;
		await Bun.sleep(5);

		await writer.stop();
		await Bun.sleep(100);

		expect(attempts).toBe(1);
	});

	it("does not retry a renewal that fails while stopping", async () => {
		let attempts = 0;
		let renewal = Promise.withResolvers<Lease | undefined>();
		let sent = Promise.withResolvers<void>();
		let writer = new WriterLease(
			leases(() => {
				attempts++;
				sent.resolve();
				return renewal.promise;
			}),
			{ ttlMs: 1_000, renewMs: 20, safetyMs: 100, retryMs: 10 },
			() => {},
		);
		writer.hold(lease());
		writer.start();
		await sent.promise;

		let stopping = writer.stop();
		renewal.reject(new Error("unavailable"));
		await stopping;
		await Bun.sleep(100);

		expect(attempts).toBe(1);
	});
});
