import { describe, expect, it } from "bun:test";
import * as Question from "@chopin/question";

import * as Store from "./store";
import { asked } from "./store.test-fixtures";

// Exact archive callbacks: 446a9779a937fa5be7cd3eb52fd7f3023d691ed2,
// apps/server/src/questions/store.test.ts.
describe("Store.suggest queue", () => {
	it("applies a human selection prepared before the server suggestion", () => {
		let questions = asked();
		Store.addOption(questions, "w", "b", "GitHub Apps");
		let before = Store.get(questions, "w")!;
		before.model = before.model.fork(65_537);
		let human = Question.crdt.Model.fromBinary(before.model.toBinary())
			.fork(65_536) as unknown as Question.Model;
		human.api.val(["q", "mode"]).set("choices");
		human.api.val(["q", "choice"]).set("b");
		let patch = human.api.flush();
		if (!patch) throw new Error("selection made no patch");
		expect(Store.suggest(questions, "w", { optionId: "a", messageIds: ["m1"] }))
			.toMatchObject({ ok: true });
		expect(Store.edit(questions, "w", [...patch.toBinary()], "ana")).toMatchObject({
			open: true,
			accepted: true,
			applied: true,
		});
		let entry = Store.get(questions, "w")!;
		expect(Question.read(entry.model, entry.definition).q!.choice).toBe("b");
		expect(entry.suggested).toBeUndefined();
		expect(entry.editors).toContain("ana");
	});

	it("keeps a delayed human selection after several changed server suggestions", () => {
		let questions = asked();
		Store.addOption(questions, "w", "b", "GitHub Apps");
		let entry = Store.get(questions, "w")!;
		entry.model = entry.model.fork(65_537);
		let human = Question.crdt.Model.fromBinary(entry.model.toBinary())
			.fork(65_536) as unknown as Question.Model;
		human.api.val(["q", "mode"]).set("choices");
		human.api.val(["q", "choice"]).set("b");
		let patch = human.api.flush();
		if (!patch) throw new Error("selection made no patch");
		for (let [index, optionId] of ["a", "b", "a", "b", "a"].entries()) {
			expect(Store.suggest(questions, "w", { optionId, messageIds: [`m${index}`] }))
				.toMatchObject({ ok: true });
		}
		expect(Store.edit(questions, "w", [...patch.toBinary()], "ana"))
			.toMatchObject({ open: true, accepted: true, applied: true });
		expect(Question.read(entry.model, entry.definition).q!.choice).toBe("b");
		expect(entry.suggested).toBeUndefined();
	});

	it("keeps two queued human choices and converges peers after repeated suggestions", () => {
		let questions = asked();
		Store.addOption(questions, "w", "b", "GitHub Apps");
		Store.addOption(questions, "w", "c", "Own service");
		let entry = Store.get(questions, "w")!;
		entry.model = entry.model.fork(65_537);
		let human = Question.crdt.Model.fromBinary(entry.model.toBinary())
			.fork(65_536) as unknown as Question.Model;
		let peer = Question.crdt.Model.fromBinary(entry.model.toBinary())
			.fork(65_538) as unknown as Question.Model;
		human.api.val(["q", "mode"]).set("choices");
		human.api.val(["q", "choice"]).set("b");
		let first = human.api.flush();
		human.api.val(["q", "mode"]).set("choices");
		human.api.val(["q", "choice"]).set("c");
		let second = human.api.flush();
		if (!first || !second) throw new Error("selections made no patches");
		for (let [index, optionId] of ["a", "b", "a", "b", "a"].entries()) {
			let suggestion = Store.suggest(questions, "w", {
				optionId,
				messageIds: [`m${index}`],
			});
			if (!suggestion.ok) throw new Error("suggestion was refused");
			expect(suggestion.patch).toEqual([]);
		}
		for (let patch of [first, second]) {
			expect(Store.edit(questions, "w", [...patch.toBinary()], "ana"))
				.toMatchObject({ open: true, accepted: true, applied: true });
			peer.applyPatch(patch);
		}
		expect(Question.read(entry.model, entry.definition).q!.choice).toBe("c");
		expect(Question.read(human, entry.definition).q!.choice).toBe("c");
		expect(Question.read(peer, entry.definition).q!.choice).toBe("c");
	});
});
