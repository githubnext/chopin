import { afterEach, expect, test } from "bun:test";
import { ExperimentStore } from "./store";
import type { PublishedInvestigation } from "@chopin/experiment/records";
import type { Wire } from "../wire";

let originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
});

function item(): PublishedInvestigation {
	return {
		id: "investigation",
		documentId: "document",
		revision: 1,
		brief: "Compare startup approaches",
		requester: "ana",
		state: "completed",
		generation: 1,
		expiresAt: 0,
		createdAt: 0,
		updatedAt: 0,
		progress: "",
		views: {},
		decisions: [],
		child: {
			id: "child",
			title: "Startup evidence",
			slug: "startup-evidence",
			summary: "Measured.",
		},
		followthrough: { id: "review", revision: 0, status: "pending" },
	};
}

function fetchWith(run: (path: string, init?: RequestInit) => Promise<Response>) {
	globalThis.fetch = Object.assign(
		(input: string | URL | Request, init?: RequestInit) => run(String(input), init),
		{ preconnect: originalFetch.preconnect },
	) as typeof fetch;
}

test("experiment notifications refresh loaded receipts without changing investigation revision", async () => {
	let value = item();
	let detailReads = 0;
	fetchWith(async path => {
		if (path.endsWith("/investigation")) {
			detailReads++;
			return Response.json(value);
		}
		return Response.json({ experiments: [{ ...value, decisionCount: 0 }] });
	});
	let store = new ExperimentStore("document");
	store.values.set(value.id, value);
	let changed!: () => void;
	let wire = {
		on: (_kind: string, callback: () => void) => {
			changed = callback;
			return () => {};
		},
	} as unknown as Wire;
	let disconnect = store.connect(wire);
	try {
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(detailReads).toBe(1);
		value = { ...value, followthrough: { id: "review", revision: 2, status: "done" } };
		changed();
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(detailReads).toBe(2);
		expect(store.get(value.id)?.revision).toBe(1);
		expect(store.get(value.id)?.followthrough?.status).toBe("done");
	} finally {
		disconnect();
	}
});

test("review actions send the receipt revision and preserve it across stale detail reads", async () => {
	let value = item();
	value.followthrough = { id: "review", revision: 1, status: "failed" };
	let calls: Array<{ path: string; body: unknown }> = [];
	let resolve!: (response: Response) => void;
	let reply = new Promise<Response>(accept => {
		resolve = accept;
	});
	fetchWith(async (path, init) => {
		if (init?.method === "POST") {
			calls.push({ path, body: JSON.parse(String(init.body)) });
			return reply;
		}
		return Response.json(value);
	});
	let store = new ExperimentStore("document");
	store.values.set(value.id, value);
	let action = store.review(value.id, "retry");
	expect(store.mutating(value.id)).toBe(true);
	await store.review(value.id, "retry");
	expect(calls).toEqual([{
		path: "/api/channels/document/followthrough/review/retry",
		body: { revision: 1 },
	}]);
	resolve(Response.json({ id: "review", revision: 2, status: "pending" }));
	await action;
	expect(store.get(value.id)?.followthrough).toEqual({
		id: "review",
		revision: 2,
		status: "pending",
	});
	expect(store.mutating(value.id)).toBe(false);
});

test("failed review mutations release controls without erasing the last durable receipt", async () => {
	let value = item();
	fetchWith(async () => Response.json({ error: "refused" }, { status: 409 }));
	let store = new ExperimentStore("document");
	store.values.set(value.id, value);
	await expect(store.review(value.id, "dismiss")).rejects.toThrow();
	expect(store.mutating(value.id)).toBe(false);
	expect(store.get(value.id)).toBe(value);
});

test("a new investigation generation does not retain the previous result's review", async () => {
	let current = item();
	let { child: _child, followthrough: _followthrough, ...next } = current;
	fetchWith(async () => Response.json({ ...next, generation: 2, revision: 2, state: "requested" }));
	let store = new ExperimentStore("document");
	store.values.set(current.id, current);
	await store.load(current.id);
	expect(store.get(current.id)?.generation).toBe(2);
	expect(store.get(current.id)?.followthrough).toBeUndefined();
});
