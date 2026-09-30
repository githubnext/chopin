import { describe, expect, it } from "bun:test";
import * as Question from "@chopin/question";

import * as Store from "./store";
import { asked, legacy } from "./store.test-fixtures";

// Original callbacks from archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2.
// Advisory retitle/editor/suggest callbacks are deferred to the next bounded slice.
describe("Store.reopen", () => {
	it("reuses identity with a fresh draft, no Planner waiter, and no old tombstone", () => {
		let questions = asked();
		let claim = Store.claimCancel(questions, "w", "ana");
		if (!claim.ok) throw new Error("setup");
		Store.commit(questions, claim.claim);
		let definition = legacy();
		Store.reopen(questions, "w", definition, "w");
		let entry = Store.get(questions, "w")!;
		expect(entry.definition).toEqual(definition);
		expect(entry.revision).toBe(0);
		expect(entry.settle).toBeUndefined();
		expect(questions.closed.has("w")).toBe(false);
		expect(Question.read(entry.model, entry.definition).q1!.choice).toBeNull();
		expect(Question.read(entry.model, entry.definition).q2!.choice).toBeNull();
		expect(Store.addOption(questions, "w", "new", "Another")).toMatchObject({
			ok: false,
			reason: "closed",
		});
		expect(() => Store.reopen(questions, "w", definition, "w")).toThrow(/already open/);
	});
});
