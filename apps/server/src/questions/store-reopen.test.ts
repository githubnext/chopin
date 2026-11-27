import { describe, expect, it } from "bun:test";
import * as Question from "@chopin/question";

import * as Store from "./store";
import { asked, legacy } from "./store.test-fixtures";

// Original callbacks from archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2.
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
		expect(entry.revision).toBe(1);
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

	it("starts reopened revisions strictly above every prior revision so pre-reopen submits are rejected as stale", () => {
		let questions = asked();
		let definition = Store.get(questions, "w")!.definition;
		let before = Store.get(questions, "w")!;
		let fork = before.model.fork() as Question.Model;
		fork.api.val(["q", "choice"]).set("a");
		let edited = Store.edit(questions, "w", [...fork.api.flush().toBinary()], "ana");
		expect(edited).toMatchObject({ open: true, accepted: true, applied: true, revision: 1 });
		let claim = Store.claimSubmit(questions, "w", 1, "ana");
		if (!claim.ok) throw new Error("setup submit failed");
		Store.commit(questions, claim.claim);

		Store.reopen(questions, "w", definition, "w");
		let reopened = Store.get(questions, "w")!;
		expect(reopened.revision).toBe(2);
		expect(Store.claimSubmit(questions, "w", 0, "ben")).toEqual({
			ok: false,
			reason: "stale",
			current: 2,
		});
		expect(Store.claimSubmit(questions, "w", 1, "ben")).toEqual({
			ok: false,
			reason: "stale",
			current: 2,
		});

		// Even after the in-memory tombstone is gone (e.g., across a restart), an explicit
		// previousRevision keeps the revision fence monotonic.
		let secondClaim = Store.claimCancel(questions, "w", "ana");
		if (!secondClaim.ok) throw new Error("setup cancel failed");
		Store.commit(questions, secondClaim.claim);
		questions.closed.delete("w");
		Store.reopen(questions, "w", definition, "w", 2);
		expect(Store.get(questions, "w")!.revision).toBe(3);
		expect(Store.claimSubmit(questions, "w", 2, "ben")).toEqual({
			ok: false,
			reason: "stale",
			current: 3,
		});
	});
});
