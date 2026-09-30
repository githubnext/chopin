import { describe, expect, it } from "bun:test";
import * as Question from "@chopin/question";

import * as Store from "./store";
import { asked } from "./store.test-fixtures";

// Original callback from archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2,
// apps/server/src/questions/store.test.ts.
describe("Store.edit editors", () => {
	it("credits applied edits, but not duplicate patches or refused edits", () => {
		let questions = asked();
		let entry = Store.get(questions, "w")!;
		let model = Question.crdt.Model.fromBinary(entry.model.toBinary())
			.fork() as unknown as Question.Model;
		model.api.val(["q", "choice"]).set("a");
		let patch = model.api.flush();
		if (!patch) throw new Error("selection made no patch");
		let binary = [...patch.toBinary()];

		expect(Store.edit(questions, "w", binary, "ana")).toMatchObject({
			open: true,
			accepted: true,
			applied: true,
		});
		expect(Store.get(questions, "w")!.editors).toEqual(new Set(["ana"]));
		expect(Store.edit(questions, "w", binary, "ben")).toMatchObject({
			open: true,
			accepted: true,
			applied: false,
		});
		expect(Store.get(questions, "w")!.editors).toEqual(new Set(["ana"]));
		let claim = Store.claimSubmit(questions, "w", 1, "ana");
		if (!claim.ok) throw new Error("selection was not claimable");
		expect(Store.edit(questions, "w", binary, "cy")).toMatchObject({ accepted: false });
		expect(Store.get(questions, "w")!.editors).toEqual(new Set(["ana"]));
		Store.rollback(questions, claim.claim);
	});
});
