import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";

import { WriterLease } from "./writer-lease";

import type { Lease } from "./model";
import type { LeaseStore } from "./port";

function lease(): Lease {
	return { name: "chopin:writer", owner: "writer", fencing: 1, expiresAt: new Date() };
}

function leases(renew: LeaseStore["renew"]): LeaseStore {
	return { acquire: async () => undefined, renew, release: async () => true };
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
