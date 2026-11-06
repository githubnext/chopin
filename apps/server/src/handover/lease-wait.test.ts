import { expect, test } from "bun:test";

import { acquireWhenFree } from "./lease-wait";

import type { Lease, LeasePeek } from "../storage/model";
import type { LeaseStore } from "../storage/port";

function lease(owner: string, fencing = 1): Lease {
	return { name: "chopin:writer", owner, fencing, expiresAt: new Date(Date.now() + 30_000) };
}

/** A lease store whose lease is held until `free()`, counting what each call would have cost. */
function store() {
	let state = { held: true, missing: false };
	let calls = { peek: 0, acquire: 0 };
	let contested = 0;
	let value: LeaseStore = {
		async peek(): Promise<LeasePeek | undefined> {
			calls.peek++;
			if (state.missing) return undefined;
			return { lease: lease("old"), free: !state.held };
		},
		async acquire(_name, owner) {
			calls.acquire++;
			if (contested > 0) {
				contested--;
				return undefined;
			}
			return state.held ? undefined : lease(owner, 2);
		},
		async renew() {
			throw new Error("a waiting process renews nothing");
		},
		async release() {
			throw new Error("a waiting process releases nothing");
		},
	};
	return {
		value,
		calls,
		free: () => (state.held = false),
		never: () => (state.missing = true, state.held = false),
		contest: (times: number) => (contested = times),
	};
}

const WAIT = { name: "chopin:writer", owner: "new", ttlMs: 30_000, pollMs: 10 };

test("it reads the lease with plain reads, and takes it only once a read shows it free", async () => {
	let leases = store();
	let controller = new AbortController();
	let acquiring = acquireWhenFree(leases.value, { ...WAIT, signal: controller.signal });
	await Bun.sleep(100);
	expect(leases.calls.peek).toBeGreaterThanOrEqual(5);
	expect(leases.calls.acquire).toBe(0);
	leases.free();
	let taken = await acquiring;
	expect(taken).toMatchObject({ owner: "new", fencing: 2 });
	expect(leases.calls.acquire).toBe(1);
});

test("it sees a release within one poll interval", async () => {
	let leases = store();
	let acquiring = acquireWhenFree(leases.value, {
		...WAIT,
		pollMs: 100,
		signal: new AbortController().signal,
	});
	await Bun.sleep(150);
	let released = performance.now();
	leases.free();
	await acquiring;
	expect(performance.now() - released).toBeLessThan(150);
});

test("a lease that was never taken is taken at once", async () => {
	let leases = store();
	leases.never();
	expect(await acquireWhenFree(leases.value, { ...WAIT, signal: new AbortController().signal }))
		.toMatchObject({ owner: "new" });
	expect(leases.calls.peek).toBe(1);
});

test("when another process wins the race the wait goes on", async () => {
	let leases = store();
	leases.free();
	leases.contest(2);
	let taken = await acquireWhenFree(leases.value, {
		...WAIT,
		signal: new AbortController().signal,
	});
	expect(taken).toBeDefined();
	expect(leases.calls.acquire).toBe(3);
});

test("it says once who holds the lease, and keeps waiting through a failed read", async () => {
	let leases = store();
	let announced: Lease[] = [];
	let failures: unknown[] = [];
	let fail = true;
	let peek = leases.value.peek.bind(leases.value);
	leases.value.peek = async name => {
		if (fail) {
			fail = false;
			throw new Error("connection reset");
		}
		return peek(name);
	};
	let acquiring = acquireWhenFree(leases.value, {
		...WAIT,
		signal: new AbortController().signal,
		waiting: holder => announced.push(holder),
		failed: error => failures.push(error),
	});
	await Bun.sleep(80);
	leases.free();
	await acquiring;
	expect(failures).toHaveLength(1);
	expect(announced).toHaveLength(1);
	expect(announced[0]).toMatchObject({ owner: "old" });
});

test("aborting ends the wait without a lease and without ever locking", async () => {
	let leases = store();
	let controller = new AbortController();
	let acquiring = acquireWhenFree(leases.value, { ...WAIT, signal: controller.signal });
	await Bun.sleep(30);
	controller.abort();
	expect(await acquiring).toBeUndefined();
	expect(leases.calls.acquire).toBe(0);
});
