import { describe, expect, it } from "bun:test";

import * as Store from "./store";
import { asked } from "./store.test-fixtures";

// Exact archive callbacks: 446a9779a937fa5be7cd3eb52fd7f3023d691ed2,
// apps/server/src/questions/store.test.ts.
describe("Store.suggest submit", () => {
	it("claims only the current visible suggestion while the draft is untouched", () => {
		let questions = asked();
		Store.addOption(questions, "w", "b", "GitHub Apps");
		let first = Store.suggest(questions, "w", { optionId: "a", messageIds: ["m1"] });
		if (!first.ok) throw new Error("suggestion was refused");
		expect(Store.claimSubmit(questions, "w", first.revision, "ana")).toMatchObject({
			ok: false,
			reason: "invalid",
		});
		let moved = Store.suggest(questions, "w", { optionId: "b", messageIds: ["m2"] });
		if (!moved.ok) throw new Error("suggestion was refused");
		expect(Store.claimSubmit(questions, "w", first.revision, "ana", "a")).toEqual({
			ok: false,
			reason: "stale",
			current: moved.revision,
		});
		expect(Store.claimSubmit(questions, "w", moved.revision, "ana", "a")).toMatchObject({
			ok: false,
			reason: "invalid",
		});
		let claim = Store.claimSubmit(questions, "w", moved.revision, "ana", "b");
		if (!claim.ok) throw new Error("current suggestion was refused");
		expect(claim.answers).toEqual([{
			question: "What auth system should we use?",
			choices: ["GitHub Apps"],
			optionIds: ["b"],
		}]);
		Store.rollback(questions, claim.claim);
	});

	it("refuses a suggestion fallback after a human draft edit", () => {
		let questions = asked();
		let suggestion = Store.suggest(questions, "w", { optionId: "a", messageIds: ["m1"] });
		if (!suggestion.ok) throw new Error("suggestion was refused");
		let entry = Store.get(questions, "w")!;
		let human = entry.model.fork();
		human.api.val(["q", "mode"]).set("custom");
		let patch = human.api.flush();
		if (!patch) throw new Error("human edit made no patch");
		expect(Store.edit(questions, "w", [...patch.toBinary()], "ana")).toMatchObject({
			accepted: true,
			applied: true,
		});
		expect(entry.suggested).toBeUndefined();
		expect(Store.claimSubmit(questions, "w", entry.revision, "ana", "a")).toMatchObject({
			ok: false,
			reason: "invalid",
		});
	});
});
