import { describe, expect, it } from "bun:test";

import { ResearchRequestStore } from "./research-requests";

import type { Research } from "@chopin/protocol";
import type { ResearchRequestApi, ResearchRequestSchedule } from "./research-requests";

function request(
	id: string,
	stage: Research.RequestStage = "queued",
	overrides: Partial<Research.RequestViewBase> & { child?: Research.ReadyChild } = {},
): Research.RequestView {
	let base: Research.RequestViewBase = {
		id,
		channelId: "channel-one",
		question: overrides.question ?? "  Keep this brief exact.  ",
		sources: overrides.sources ?? [],
		createdAt: overrides.createdAt ?? "2026-08-24T09:00:00.000Z",
		updatedAt: overrides.updatedAt ?? "2026-08-24T09:01:00.000Z",
	};
	if (stage === "failed") {
		return { ...base, state: "failed", stage, error: "Research could not be completed." };
	}
	if (stage === "cancelled") return { ...base, state: "cancelled", stage };
	if (stage === "ready") {
		let child = overrides.child ?? {
			id: "child-one",
			title: "Research report",
			slug: "research-report",
			summary: "Completed research.",
			sourceCount: 0,
		};
		return { ...base, state: "completed", stage, child };
	}
	return { ...base, state: "running", stage };
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
		cancel: async (_channelId, id) => request(id, "cancelled"),
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
		let release = store.retain("restored");
		let releaseDuplicate = store.retain("restored");
		expect(calls).toBe(1);

		load.resolve(request("restored", "searching"));
		await settle();
		expect(store.get("restored")?.stage).toBe("searching");
		releaseDuplicate();
		release();
		unsubscribe();
		store.dispose();
	});

	it("restores mounted references after Strict Mode rehearses cleanup", async () => {
		let calls = 0;
		let ready = request("request-one", "ready", {
			child: {
				id: "child-one",
				slug: "research-report",
				sourceCount: 2,
				summary: "Completed research.",
				title: "Research report",
			},
		});
		let store = new ResearchRequestStore({
			api: api({
				get: async () => {
					calls++;
					return ready;
				},
			}),
			channelId: "channel-one",
			onOpen() {},
		});

		store.reset();
		let unsubscribe = store.subscribe(() => {});
		let release = store.retain("request-one");
		await settle();

		expect(calls).toBe(1);
		expect(store.get("request-one")).toBe(ready);
		release();
		unsubscribe();
		store.dispose();
	});

	it("keeps a newly created request after Strict Mode rehearses cleanup", async () => {
		let store = new ResearchRequestStore({
			api: api(),
			channelId: "channel-one",
			onOpen() {},
		});

		store.reset();
		let created = await store.create("Research this", "request-one");

		expect(store.get("request-one")).toBe(created);
		store.dispose();
	});

	it("keeps terminal disposal distinct from reversible Strict Mode cleanup", async () => {
		let reads = 0;
		let creates = 0;
		let store = new ResearchRequestStore({
			api: api({
				get: async (_channelId, id) => {
					reads++;
					return request(id);
				},
				create: async (_channelId, question, id) => {
					creates++;
					return { repeated: false, request: request(id, "queued", { question }) };
				},
			}),
			channelId: "channel-one",
			onOpen() {},
		});

		store.dispose();
		let unsubscribe = store.subscribe(() => {});
		let release = store.retain("request-one");
		await settle();

		expect(reads).toBe(0);
		expect(store.get("request-one")).toBeUndefined();
		await expect(store.create("Research this", "request-one")).rejects.toThrow("disposed");
		expect(creates).toBe(0);
		release();
		unsubscribe();
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
		let release = store.retain("mounted");
		await settle();

		store.invalidate("not-mounted");
		store.invalidate("mounted");
		await settle();

		expect(calls).toEqual(["mounted", "mounted"]);
		release();
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
		let release = store.retain("request-one");
		store.invalidate("request-one");

		second.resolve(request("request-one", "writing", {
			updatedAt: "2026-08-24T09:03:00.000Z",
		}));
		await settle();
		first.resolve(request("request-one", "searching"));
		await settle();

		expect(calls).toBe(2);
		expect(store.get("request-one")?.stage).toBe("writing");
		release();
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

		let release = store.retain("request-one");
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

		release();
		unsubscribe();
		store.dispose();
	});

	it("releasing the final mounted reference cancels fallback polling", async () => {
		let clock = scheduler();
		let store = new ResearchRequestStore({
			api: api(),
			channelId: "channel-one",
			onOpen() {},
			schedule: clock.schedule,
		});
		let unsubscribe = store.subscribe(() => {});
		let release = store.retain("request-one");
		await settle();
		expect(clock.pending).toBe(1);

		release();

		expect(clock.pending).toBe(0);
		unsubscribe();
		store.dispose();
	});

	it("releases one unmounted request while another card keeps polling", async () => {
		let clock = scheduler();
		let calls: string[] = [];
		let first = deferred<Research.RequestView>();
		let firstSignal: AbortSignal | undefined;
		let store = new ResearchRequestStore({
			api: api({
				get: async (_channelId, id, signal) => {
					calls.push(id);
					if (id === "request-one") {
						firstSignal = signal;
						return first.promise;
					}
					return request(id, "searching");
				},
			}),
			channelId: "channel-one",
			onOpen() {},
			schedule: clock.schedule,
		});
		let unsubscribe = store.subscribe(() => {});
		let releaseOne = store.retain("request-one");
		let releaseTwo = store.retain("request-two");
		await settle();

		releaseOne();
		expect(firstSignal?.aborted).toBe(true);
		store.invalidate("request-one");
		expect(store.get("request-one")).toBeUndefined();
		clock.run();
		await settle();

		expect(calls.filter(id => id === "request-one")).toHaveLength(1);
		expect(calls.filter(id => id === "request-two")).toHaveLength(2);
		expect(clock.pending).toBe(1);
		releaseTwo();
		expect(clock.pending).toBe(0);
		unsubscribe();
		store.dispose();
	});

	it("keeps an immediate re-retain read after the aborted read settles", async () => {
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
		let releaseFirst = store.retain("request-one");
		releaseFirst();
		let releaseSecond = store.retain("request-one");
		expect(calls).toBe(2);

		first.resolve(request("request-one", "searching"));
		await settle();
		second.resolve(request("request-one", "writing", {
			updatedAt: "2026-08-24T09:03:00.000Z",
		}));
		await settle();

		expect(store.get("request-one")).toMatchObject({
			stage: "writing",
			updatedAt: "2026-08-24T09:03:00.000Z",
		});
		releaseSecond();
		unsubscribe();
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

	it("restores a failed request and retries it by durable identity", async () => {
		let retries: string[] = [];
		let initial = request("request-one", "failed", {
			question: "  Exact stored question.  ",
		});
		let store = new ResearchRequestStore({
			api: api({
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
		let release = store.retain("request-one");
		await settle();

		let retried = await store.retry("request-one");
		expect(retries).toEqual(["request-one"]);
		expect(store.get("request-one")).toBe(retried);

		release();
		unsubscribe();
		store.dispose();
	});

	it("publishes a successful cancellation", async () => {
		let store = new ResearchRequestStore({
			api: api(),
			channelId: "channel-one",
			onOpen() {},
		});
		let unsubscribe = store.subscribe(() => {});
		let release = store.retain("request-one");
		await settle();

		let cancelled = await store.cancel("request-one");

		expect(cancelled.stage).toBe("cancelled");
		expect(store.get("request-one")).toBe(cancelled);
		release();
		unsubscribe();
		store.dispose();
	});

	it("keeps authoritative sources and ready-child metadata unchanged", async () => {
		let ready = request("request-one", "ready", {
			child: {
				id: "child-one",
				slug: "source-report",
				sourceCount: 1,
				summary: "Validated report summary",
				title: "Source report",
			},
			sources: [{ title: "Primary source", url: "https://example.com/source" }],
		});
		let store = new ResearchRequestStore({
			api: api({ get: async () => ready }),
			channelId: "channel-one",
			onOpen() {},
		});
		let unsubscribe = store.subscribe(() => {});
		let release = store.retain("request-one");
		await settle();

		expect(store.get("request-one")).toBe(ready);
		expect("summary" in store.get("request-one")!).toBe(false);

		release();
		unsubscribe();
		store.dispose();
	});

	it("announces the first accepted transition from pending work to a published child", async () => {
		let readyChild: Research.ReadyChild = {
			id: "child-one",
			slug: "source-report",
			sourceCount: 1,
			summary: "A complete report.",
			title: "Source report",
		};
		let snapshots = [
			request("request-one", "queued"),
			request("request-one", "ready", { child: readyChild }),
			request("request-one", "ready", { child: readyChild }),
		];
		let published: Research.ReadyChild[] = [];
		let store = new ResearchRequestStore({
			api: api({ get: async () => snapshots.shift()! }),
			channelId: "channel-one",
			onOpen() {},
			onPublished: child => published.push(child),
		});
		let unsubscribe = store.subscribe(() => {});
		let release = store.retain("request-one");
		await settle();

		store.invalidate("request-one");
		await settle();
		store.invalidate("request-one");
		await settle();

		expect(published).toEqual([readyChild]);
		release();
		unsubscribe();
		store.dispose();
	});

	it("does not announce restored, terminal, stale, released, or disposed snapshots", async () => {
		let readyChild: Research.ReadyChild = {
			id: "child-one",
			slug: "source-report",
			sourceCount: 1,
			summary: "A complete report.",
			title: "Source report",
		};
		let stale = deferred<Research.RequestView>();
		let current = deferred<Research.RequestView>();
		let calls = 0;
		let published: Research.ReadyChild[] = [];
		let store = new ResearchRequestStore({
			api: api({
				get: async (_channelId, id) => {
					if (id === "restored") return request(id, "ready", { child: readyChild });
					if (id === "failed") {
						return request(id, "failed", { child: readyChild, state: "failed" });
					}
					if (id === "cancelled") {
						return request(id, "cancelled", { child: readyChild, state: "cancelled" });
					}
					return ++calls === 1 ? stale.promise : current.promise;
				},
			}),
			channelId: "channel-one",
			onOpen() {},
			onPublished: child => published.push(child),
		});
		let unsubscribe = store.subscribe(() => {});
		let releaseRestored = store.retain("restored");
		let releaseFailed = store.retain("failed");
		let releaseCancelled = store.retain("cancelled");
		let releaseLate = store.retain("late");
		store.invalidate("late");
		await settle();

		current.resolve(request("late", "writing"));
		await settle();
		stale.resolve(request("late", "ready", { child: readyChild }));
		await settle();
		releaseLate();
		store.dispose();

		expect(published).toEqual([]);
		releaseRestored();
		releaseFailed();
		releaseCancelled();
		unsubscribe();
	});

	it("hands a ready child to app navigation", () => {
		let opened: Array<{
			child: Research.ReadyChild;
			opener: { readonly current: HTMLElement | null };
		}> = [];
		let store = new ResearchRequestStore({
			api: api(),
			channelId: "channel-one",
			onOpen: (child, opener) => opened.push({ child, opener }),
		});
		let child: Research.ReadyChild = {
			id: "child-one",
			slug: "source-report",
			sourceCount: 3,
			summary: "A complete report.",
			title: "Source report",
		};

		let first = { focus() {} } as HTMLElement;
		let replacement = { focus() {} } as HTMLElement;
		let opener = store.opener("workspace-one", first);
		expect(store.opener("workspace-one", replacement)).toBe(opener);
		store.open(child, opener);

		expect(opened).toEqual([{ child, opener }]);
		expect(opener.current).toBe(replacement);
		store.dispose();
	});
});
