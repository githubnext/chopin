import { describe, expect, it } from "bun:test";

import { ResearchRequestStore } from "./research-requests";

import type { Research } from "@chopin/protocol";
import type { ResearchRequestApi, ResearchRequestSchedule } from "./research-requests";

function request(
	id: string,
	stage: Research.RequestStage = "queued",
	overrides: Partial<Research.RequestView> = {},
): Research.RequestView {
	return {
		id,
		channelId: "channel-one",
		question: "  Keep this brief exact.  ",
		state: stage === "ready" ? "completed" : stage === "failed" ? "failed" : "running",
		stage,
		sources: [],
		createdAt: "2026-08-24T09:00:00.000Z",
		updatedAt: "2026-08-24T09:01:00.000Z",
		...overrides,
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	let promise = new Promise<T>((accept, decline) => {
		resolve = accept;
		reject = decline;
	});
	return { promise, reject, resolve };
}

function api(
	overrides: Partial<ResearchRequestApi> = {},
): ResearchRequestApi {
	return {
		cancel: async (_channelId, id) => request(id, "cancelled", { state: "cancelled" }),
		create: async (_channelId, question, id) => ({
			repeated: false,
			request: request(id, "queued", { question }),
		}),
		get: async (_channelId, id) => request(id),
		retry: async (_channelId, id) => request(id),
		...overrides,
	};
}

function scheduler() {
	let callbacks: Array<() => void> = [];
	let schedule: ResearchRequestSchedule = callback => {
		callbacks.push(callback);
		return () => {
			callbacks = callbacks.filter(candidate => candidate !== callback);
		};
	};
	return {
		get pending() {
			return callbacks.length;
		},
		run() {
			let callback = callbacks.shift();
			if (!callback) throw new Error("no scheduled research poll");
			callback();
		},
		schedule,
	};
}

async function settle() {
	await Promise.resolve();
	await Promise.resolve();
}

describe("research request store", () => {
	it("starts one request with the exact brief and stable request identity", async () => {
		let calls: Array<{ channelId: string; question: string; requestId: string }> = [];
		let store = new ResearchRequestStore({
			api: api({
				create: async (channelId, question, requestId) => {
					calls.push({ channelId, question, requestId });
					return {
						repeated: false,
						request: request("durable-request", "queued", { question }),
					};
				},
			}),
			channelId: "channel-one",
			onOpen() {},
		});
		let notifications = 0;
		let unsubscribe = store.subscribe(() => notifications++);

		let created = await store.create("  Keep this brief exact.  ", "request-stable");

		expect(calls).toEqual([{
			channelId: "channel-one",
			question: "  Keep this brief exact.  ",
			requestId: "request-stable",
		}]);
		expect(created.id).toBe("durable-request");
		expect(store.get("durable-request")).toBe(created);
		expect(notifications).toBe(1);
		unsubscribe();
		store.dispose();
	});

	it("restores an unknown durable reference and deduplicates concurrent refreshes", async () => {
		let load = deferred<Research.RequestView>();
		let calls = 0;
		let store = new ResearchRequestStore({
			api: api({
				get: async () => {
					calls++;
					return load.promise;
				},
			}),
			channelId: "channel-one",
			onOpen() {},
		});
		let unsubscribe = store.subscribe(() => {});

		expect(store.get("restored")).toBeUndefined();
		store.refresh("restored");
		store.refresh("restored");
		expect(calls).toBe(1);

		load.resolve(request("restored", "searching"));
		await settle();
		expect(store.get("restored")?.stage).toBe("searching");
		unsubscribe();
		store.dispose();
	});

	it("refreshes only a mounted request named by socket invalidation", async () => {
		let calls: string[] = [];
		let store = new ResearchRequestStore({
			api: api({
				get: async (_channelId, id) => {
					calls.push(id);
					return request(id, "searching");
				},
			}),
			channelId: "channel-one",
			onOpen() {},
		});
		let unsubscribe = store.subscribe(() => {});
		store.refresh("mounted");
		await settle();

		store.invalidate("not-mounted");
		store.invalidate("mounted");
		await settle();

		expect(calls).toEqual(["mounted", "mounted"]);
		unsubscribe();
		store.dispose();
	});

	it("ignores a stale refresh after a newer invalidation result", async () => {
		let first = deferred<Research.RequestView>();
		let second = deferred<Research.RequestView>();
		let calls = 0;
		let store = new ResearchRequestStore({
			api: api({
				get: async () => (++calls === 1 ? first.promise : second.promise),
			}),
			channelId: "channel-one",
			onOpen() {},
		});
		let unsubscribe = store.subscribe(() => {});
		store.refresh("request-one");
		store.invalidate("request-one");

		second.resolve(request("request-one", "writing", {
			updatedAt: "2026-08-24T09:03:00.000Z",
		}));
		await settle();
		first.resolve(request("request-one", "searching"));
		await settle();

		expect(calls).toBe(2);
		expect(store.get("request-one")?.stage).toBe("writing");
		unsubscribe();
		store.dispose();
	});

	it("polls non-terminal mounted work and stops at ready", async () => {
		let clock = scheduler();
		let stages: Research.RequestStage[] = ["searching", "publishing", "ready"];
		let store = new ResearchRequestStore({
			api: api({
				get: async (_channelId, id) => request(id, stages.shift()!),
			}),
			channelId: "channel-one",
			onOpen() {},
			schedule: clock.schedule,
		});
		let unsubscribe = store.subscribe(() => {});

		store.refresh("request-one");
		await settle();
		expect(clock.pending).toBe(1);
		clock.run();
		await settle();
		expect(store.get("request-one")?.stage).toBe("publishing");
		expect(clock.pending).toBe(1);
		clock.run();
		await settle();
		expect(store.get("request-one")?.stage).toBe("ready");
		expect(clock.pending).toBe(0);

		unsubscribe();
		store.dispose();
	});

	it("removing the final mounted reference cancels fallback polling", async () => {
		let clock = scheduler();
		let store = new ResearchRequestStore({
			api: api(),
			channelId: "channel-one",
			onOpen() {},
			schedule: clock.schedule,
		});
		let unsubscribe = store.subscribe(() => {});
		store.refresh("request-one");
		await settle();
		expect(clock.pending).toBe(1);

		unsubscribe();

		expect(clock.pending).toBe(0);
		store.dispose();
	});

	it("keeps the durable snapshot visible when cancellation fails", async () => {
		let failure = new Error("Try cancellation again.");
		let store = new ResearchRequestStore({
			api: api({
				cancel: async () => {
					throw failure;
				},
			}),
			channelId: "channel-one",
			onOpen() {},
		});
		let unsubscribe = store.subscribe(() => {});
		await store.create("Question", "request-one");
		let before = store.get("request-one");

		expect(store.cancel("request-one")).rejects.toBe(failure);
		await settle();
		expect(store.get("request-one")).toBe(before);

		unsubscribe();
		store.dispose();
	});

	it("publishes a successful cancellation and retries the same exact request", async () => {
		let retries: string[] = [];
		let initial = request("request-one", "failed", {
			error: "Research could not be completed.",
			question: "  Exact stored question.  ",
			state: "failed",
		});
		let store = new ResearchRequestStore({
			api: api({
				cancel: async () => request("request-one", "cancelled", { state: "cancelled" }),
				retry: async (_channelId, requestId) => {
					retries.push(requestId);
					return request(requestId, "queued", { question: initial.question });
				},
				get: async () => initial,
			}),
			channelId: "channel-one",
			onOpen() {},
		});
		let unsubscribe = store.subscribe(() => {});
		store.refresh("request-one");
		await settle();

		let retried = await store.retry("request-one", "  Exact stored question.  ");
		expect(retries).toEqual(["request-one"]);
		expect(store.get("request-one")).toBe(retried);
		let cancelled = await store.cancel("request-one");
		expect(cancelled.stage).toBe("cancelled");
		expect(store.get("request-one")).toBe(cancelled);

		unsubscribe();
		store.dispose();
	});

	it("keeps authoritative safe error, sources, and ready-child metadata unchanged", async () => {
		let ready = request("request-one", "ready", {
			child: {
				id: "child-one",
				slug: "source-report",
				sourceCount: 1,
				summary: "Validated report summary",
				title: "Source report",
			},
			error: "Safe server error",
			sources: [{ title: "Primary source", url: "https://example.com/source" }],
		});
		let store = new ResearchRequestStore({
			api: api({ get: async () => ready }),
			channelId: "channel-one",
			onOpen() {},
		});
		let unsubscribe = store.subscribe(() => {});
		store.refresh("request-one");
		await settle();

		expect(store.get("request-one")).toBe(ready);
		expect("summary" in store.get("request-one")!).toBe(false);

		unsubscribe();
		store.dispose();
	});

	it("hands a ready child to app navigation", () => {
		let opened: Research.ReadyChild[] = [];
		let store = new ResearchRequestStore({
			api: api(),
			channelId: "channel-one",
			onOpen: child => opened.push(child),
		});
		let child: Research.ReadyChild = {
			id: "child-one",
			slug: "source-report",
			sourceCount: 3,
			summary: "A complete report.",
			title: "Source report",
		};

		store.open(child);

		expect(opened).toEqual([child]);
		store.dispose();
	});
});
