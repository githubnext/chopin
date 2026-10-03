import { expect, test } from "bun:test";
import { openPlan } from "../testing/plan";
import * as Plan from "../plan/service";
import { type PlacementDependencies, placeResearchReference } from "./placement";

test("closing room defers before requesting its document lock", async () => {
	let calls: string[] = [];
	let deps: PlacementDependencies = {
		get: () => ({ plan: undefined, closing: Promise.resolve() }),
		exclusive: async (_id, action) => {
			calls.push("lock");
			return action();
		},
		detached: async () => {
			throw new Error("must not open detached plan");
		},
	};
	expect(await placeResearchReference("channel", "workspace", deps)).toBe("deferred");
	expect(calls).toEqual([]);
});

test("closing that begins while waiting for the document lock also defers", async () => {
	let closing: Promise<void> | undefined;
	let deps: PlacementDependencies = {
		get: () => ({ plan: undefined, closing }),
		exclusive: async (_id, action) => {
			closing = Promise.resolve();
			return action();
		},
		detached: async () => {
			throw new Error("must not open detached plan");
		},
	};
	expect(await placeResearchReference("channel", "workspace", deps)).toBe("deferred");
});

test("closing Plan persistence defers live and detached placement without writes", async () => {
	let opened = await openPlan();
	let plan = opened.plan;
	let revision = plan.persistence.revision;
	let live = true;
	let deps: PlacementDependencies = {
		get: () => live ? { plan, closing: undefined } : undefined,
		exclusive: async (_id, action) => action(),
		detached: async (_id, action) => action(plan),
	};
	try {
		plan.persistence.closing = true;
		expect(await placeResearchReference(plan.id, "workspace", deps)).toBe("deferred");
		live = false;
		expect(await placeResearchReference(plan.id, "workspace", deps)).toBe("deferred");
		expect(plan.persistence.revision).toBe(revision);
	} finally {
		plan.persistence.closing = false;
		await Plan.close(plan);
	}
});
