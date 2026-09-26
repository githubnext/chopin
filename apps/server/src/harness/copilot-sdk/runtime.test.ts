import { describe, expect, it } from "bun:test";

import { Runtime } from "./runtime";

import type { CopilotSession, SessionConfig } from "@github/copilot-sdk";
import type { RuntimeClient } from "./runtime";

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	let promise = new Promise<T>((success, failure) => {
		resolve = success;
		reject = failure;
	});
	return { promise, resolve, reject };
}

function fakeSession(id: string, disconnect: () => Promise<void>): CopilotSession {
	return { sessionId: id, disconnect } as CopilotSession;
}

let config = { model: "model" } as SessionConfig;

describe("shared Copilot runtime", () => {
	it("starts once for concurrent session opens", async () => {
		let entered = deferred<void>();
		let ready = deferred<void>();
		let starts = 0;
		let created = 0;
		let disconnected: string[] = [];
		let deleted: string[] = [];
		let stops = 0;
		let cleanups = 0;
		let client: RuntimeClient = {
			async start() {
				starts++;
				entered.resolve();
				await ready.promise;
			},
			async createSession() {
				let id = `session-${++created}`;
				return fakeSession(id, async () => {
					disconnected.push(id);
				});
			},
			async deleteSession(id) {
				deleted.push(id);
			},
			async forceStop() {},
			async stop() {
				stops++;
				return [];
			},
		};
		let runtime = new Runtime(() => ({
			client,
			cleanup: () => cleanups++,
		}));

		let first = runtime.open(config);
		let second = runtime.open(config);
		await entered.promise;
		expect(starts).toBe(1);
		expect(created).toBe(0);
		ready.resolve();
		let sessions = await Promise.all([first, second]);
		expect(sessions.map(session => session.sessionId)).toEqual(["session-1", "session-2"]);

		await runtime.discard(sessions[0]!);
		await runtime.discard(sessions[0]!);
		await runtime.shutdown();
		expect(disconnected.sort()).toEqual(["session-1", "session-2"]);
		expect(deleted.sort()).toEqual(["session-1", "session-2"]);
		expect(stops).toBe(1);
		expect(cleanups).toBe(1);
	});

	it("clears a failed startup generation so a later open can retry", async () => {
		let generations = 0;
		let stops: number[] = [];
		let cleanups: number[] = [];
		let runtime = new Runtime(() => {
			let generation = ++generations;
			let client: RuntimeClient = {
				async start() {
					if (generation === 1) throw new Error("runtime unavailable");
				},
				async createSession() {
					return fakeSession(`session-${generation}`, async () => {});
				},
				async deleteSession() {},
				async forceStop() {},
				async stop() {
					stops.push(generation);
					return [];
				},
			};
			return {
				client,
				cleanup: () => cleanups.push(generation),
			};
		});

		await expect(runtime.open(config)).rejects.toThrow("runtime unavailable");
		let session = await runtime.open(config);
		expect(session.sessionId).toBe("session-2");
		expect(generations).toBe(2);
		expect(stops).toEqual([1]);
		expect(cleanups).toEqual([1]);
		await runtime.shutdown();
		expect(stops).toEqual([1, 2]);
		expect(cleanups).toEqual([1, 2]);
	});

	it("rejects new and in-flight sessions once shutdown begins", async () => {
		let creating = deferred<void>();
		let created = deferred<CopilotSession>();
		let disconnected = 0;
		let deleted = 0;
		let stops = 0;
		let cleanups = 0;
		let client: RuntimeClient = {
			async start() {},
			async createSession() {
				creating.resolve();
				return created.promise;
			},
			async deleteSession() {
				deleted++;
			},
			async forceStop() {},
			async stop() {
				stops++;
				return [];
			},
		};
		let runtime = new Runtime(() => ({
			client,
			cleanup: () => cleanups++,
		}));

		let opening = runtime.open(config);
		await creating.promise;
		let stopping = runtime.shutdown();
		created.resolve(fakeSession("late", async () => {
			disconnected++;
		}));
		await expect(opening).rejects.toThrow("shutting down");
		await stopping;
		await expect(runtime.open(config)).rejects.toThrow("shutting down");
		await runtime.shutdown();
		expect(disconnected).toBe(1);
		expect(deleted).toBe(1);
		expect(stops).toBe(1);
		expect(cleanups).toBe(1);
	});

	it("reports runtime cleanup errors after completing cleanup", async () => {
		let cleaned = false;
		let client: RuntimeClient = {
			async start() {},
			async createSession() {
				return fakeSession("session", async () => {});
			},
			async deleteSession() {},
			async forceStop() {},
			async stop() {
				return [new Error("runtime stop failed")];
			},
		};
		let runtime = new Runtime(() => ({
			client,
			cleanup: () => {
				cleaned = true;
			},
		}));
		await runtime.open(config);

		await expect(runtime.shutdown()).rejects.toThrow("runtime stop failed");
		expect(cleaned).toBe(true);
	});

	it("waits for an in-flight discard before stopping the runtime", async () => {
		let disconnecting = deferred<void>();
		let release = deferred<void>();
		let deleted = 0;
		let stops = 0;
		let client: RuntimeClient = {
			async start() {},
			async createSession() {
				return fakeSession("session", async () => {
					disconnecting.resolve();
					await release.promise;
				});
			},
			async deleteSession() {
				deleted++;
			},
			async forceStop() {},
			async stop() {
				stops++;
				return [];
			},
		};
		let runtime = new Runtime(() => ({ client, cleanup: () => {} }));
		let session = await runtime.open(config);

		let discarding = runtime.discard(session);
		await disconnecting.promise;
		let stopping = runtime.shutdown();
		await Promise.resolve();
		expect(stops).toBe(0);
		release.resolve();
		await Promise.all([discarding, stopping]);
		expect(deleted).toBe(1);
		expect(stops).toBe(1);
	});

	it("force-stops when graceful session and runtime cleanup hang", async () => {
		let forceStops = 0;
		let cleaned = false;
		let never = new Promise<void>(() => {});
		let client: RuntimeClient = {
			async start() {},
			async createSession() {
				return fakeSession("session", () => never);
			},
			async deleteSession() {
				await never;
			},
			async forceStop() {
				forceStops++;
			},
			async stop() {
				await never;
				return [];
			},
		};
		let runtime = new Runtime(() => ({
			client,
			cleanup: () => {
				cleaned = true;
			},
		}), 10);
		await runtime.open(config);

		await expect(runtime.shutdown()).rejects.toThrow("could not shut down cleanly");
		expect(forceStops).toBe(1);
		expect(cleaned).toBe(true);
	});

	it("leaves a session that resolves after disposal to the stopped client", async () => {
		let creating = deferred<void>();
		let created = deferred<CopilotSession>();
		let disconnected = 0;
		let deleted = 0;
		let cleaned = false;
		let client: RuntimeClient = {
			async start() {},
			async createSession() {
				creating.resolve();
				return created.promise;
			},
			async deleteSession() {
				deleted++;
			},
			async forceStop() {},
			async stop() {
				return [];
			},
		};
		let runtime = new Runtime(() => ({
			client,
			cleanup: () => {
				cleaned = true;
			},
		}), 10);

		let opening = runtime.open(config);
		await creating.promise;
		await expect(runtime.shutdown()).rejects.toThrow("did not stop before shutdown");
		expect(cleaned).toBe(true);
		created.resolve(fakeSession("late", async () => {
			disconnected++;
		}));
		await expect(opening).rejects.toThrow("shutting down");
		expect(disconnected).toBe(0);
		expect(deleted).toBe(0);
	});
});
