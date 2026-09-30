import { describe, expect, it } from "bun:test";
import * as Question from "@chopin/question";

import * as Store from "./store";
import { asked } from "./store.test-fixtures";

// Original callbacks from archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2.
// Advisory retitle/editor/suggest callbacks are deferred to the next bounded slice.
describe("Store.addOption", () => {
	it("grows the definition and shared draft together", () => {
		let questions = asked();
		let result = Store.addOption(questions, "w", "b", " GitHub Apps ");
		expect(result).toMatchObject({
			ok: true,
			revision: 1,
			option: { id: "b", label: "GitHub Apps" },
		});
		let entry = Store.get(questions, "w")!;
		expect(entry.definition.questions[0].options.map(option => option.label)).toEqual([
			"Auth0",
			"GitHub Apps",
		]);
		expect(Question.read(entry.model, entry.definition).q!.options.b).toBe(false);
		expect(Store.claimSubmit(questions, "w", 0, "ana")).toMatchObject({
			ok: false,
			reason: "stale",
			current: 1,
		});
	});

	it("reports the second of two identical adds as a duplicate", () => {
		let questions = asked();
		Store.addOption(questions, "w", "b", "GitHub Apps");
		expect(Store.addOption(questions, "w", "c", "github apps")).toMatchObject({
			ok: false,
			reason: "duplicate",
		});
		expect(Store.get(questions, "w")!.definition.questions[0].options).toHaveLength(2);
	});

	it("refuses an invalid label, a full card, a resolving card, and a closed card", () => {
		let questions = asked();
		expect(Store.addOption(questions, "w", "b", "  ")).toMatchObject({
			ok: false,
			reason: "invalid",
		});
		let claim = Store.claimCancel(questions, "w", "ana");
		expect(Store.addOption(questions, "w", "b", "GitHub Apps")).toMatchObject({
			ok: false,
			reason: "closed",
		});
		if (claim.ok) Store.commit(questions, claim.claim);
		expect(Store.addOption(questions, "w", "b", "GitHub Apps")).toMatchObject({
			ok: false,
			reason: "closed",
		});

		let full = asked();
		for (let i = 1; i < 10; i++) {
			expect(Store.addOption(full, "w", `o${i}`, `Option ${i}`)).toMatchObject({ ok: true });
		}
		expect(Store.addOption(full, "w", "overflow", "Overflow")).toMatchObject({
			ok: false,
			reason: "full",
		});
	});

	it("reverts to exactly the previous definition, model, and revision", () => {
		let questions = asked();
		let before = Store.before(questions, "w")!;
		Store.addOption(questions, "w", "b", "GitHub Apps");
		Store.revert(questions, "w", before);
		let entry = Store.get(questions, "w")!;
		expect(entry.definition.questions[0].options).toHaveLength(1);
		expect(entry.revision).toBe(0);
		expect(Question.read(entry.model, entry.definition).q!.options).toEqual({ a: false });
	});
});
