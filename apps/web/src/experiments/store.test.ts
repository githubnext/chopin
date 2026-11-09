import { afterEach, expect, test } from "bun:test";
import { ExperimentStore } from "./store";

import type { InvestigationSummary } from "@chopin/experiment/records";

let original = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = original;
});

function summary(revision: number): InvestigationSummary {
	return {
		id: "investigation",
		brief: "Compare startup approaches",
		state: "requested",
		revision,
		requester: "ana",
		progress: "",
		createdAt: 0,
		decisionCount: 0,
	};
}

test("the list asked for again every few seconds is published only when it changed", async () => {
	let listed = [summary(1)];
	globalThis.fetch =
		(async () =>
			Response.json({ experiments: structuredClone(listed) })) as unknown as typeof fetch;
	let store = new ExperimentStore("document");
	let heard = 0;
	store.subscribe(() => heard++);
	await store.refresh();
	expect(heard).toBe(1);
	let held = store.items;
	// The same list in a new answer renders nothing again, and the page keeps the list it holds.
	await store.refresh();
	await store.refresh();
	expect(heard).toBe(1);
	expect(store.items).toBe(held);
	listed = [summary(2)];
	await store.refresh();
	expect(heard).toBe(2);
	expect(store.items[0]!.revision).toBe(2);
	// A failure is told once, and a good answer after it clears it.
	globalThis.fetch =
		(async () =>
			Response.json({ error: "unavailable" }, { status: 503 })) as unknown as typeof fetch;
	await store.refresh();
	await store.refresh();
	expect(heard).toBe(3);
	expect(store.error).toBe("unavailable");
	globalThis.fetch =
		(async () =>
			Response.json({ experiments: structuredClone(listed) })) as unknown as typeof fetch;
	await store.refresh();
	expect(heard).toBe(4);
	expect(store.error).toBe("");
});
