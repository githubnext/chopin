import { expect, test } from "bun:test";
import { ReadinessReviews } from "./readiness-review";

test("unchanged completed evidence is reviewed once even when its requirement remains", async () => {
	let calls = 0;
	let value = {
		id: "evidence",
		revision: 1,
		state: "completed" as const,
		buildBlocker: "Choose approach",
	};
	let reviews = new ReadinessReviews({
		list: async () => [value],
		start: async (_id, about) => {
			calls++;
			await about.ended!({ status: "failed" });
			return true;
		},
	});
	await reviews.review("document");
	await reviews.evidence("document");
	await reviews.evidence("document");
	expect(calls).toBe(1);
	value.revision++;
	await reviews.evidence("document");
	expect(calls).toBe(2);
});

test("completed evidence waits for an owner and retries when one becomes available", async () => {
	let ready = false;
	let calls = 0;
	let reviews = new ReadinessReviews({
		list: async () => [
			{ id: "evidence", revision: 1, state: "completed", buildBlocker: "Choose" } as const,
		],
		start: async (_id, about) => {
			if (!ready) return false;
			calls++;
			await about.ended!({ status: "done" });
			return true;
		},
	});
	await reviews.evidence("document");
	ready = true;
	await reviews.evidence("document");
	expect(calls).toBe(1);
});
