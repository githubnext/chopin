import { describe, expect, it } from "bun:test";
import * as Question from "@chopin/question";

import * as Store from "./store";
import { asked } from "./store.test-fixtures";

// Exact archive callbacks: 446a9779a937fa5be7cd3eb52fd7f3023d691ed2,
// apps/server/src/questions/store.test.ts.
describe("Store.suggest state", () => {
	it("retains a known suggestion without changing the human-owned draft", () => {
		let questions = asked();
		let result = Store.suggest(questions, "w", { optionId: "a", messageIds: ["m1"] });
		expect(result).toMatchObject({ ok: true, revision: 1 });
		let entry = Store.get(questions, "w")!;
		expect(Question.read(entry.model, entry.definition).q!.choice).toBeNull();
		expect(entry.suggested).toEqual({ optionId: "a", messageIds: ["m1"], revision: 1 });
		expect(Store.restore(Store.dump(questions)).open.get("w")!.suggested).toEqual({
			optionId: "a",
			messageIds: ["m1"],
			revision: 1,
		});
	});

	it("replaying the same suggestion is a no-op, while new evidence can move it", () => {
		let questions = asked();
		Store.addOption(questions, "w", "b", "GitHub Apps");
		expect(Store.suggest(questions, "w", { optionId: "a", messageIds: ["m1"] }))
			.toMatchObject({ ok: true, revision: 2 });
		expect(Store.suggest(questions, "w", { optionId: "a", messageIds: ["m1"] }))
			.toEqual({ ok: true, patch: [], revision: 2 });
		expect(Store.suggest(questions, "w", { optionId: "b", messageIds: ["m2"] }))
			.toMatchObject({ ok: true, revision: 3 });
		expect(Store.get(questions, "w")!.suggested).toEqual({
			optionId: "b",
			messageIds: ["m2"],
			revision: 3,
		});
	});

	it("does not replace a human selection and clears a suggestion only after an applied edit", () => {
		let questions = asked();
		expect(Store.addOption(questions, "w", "b", "GitHub Apps")).toMatchObject({ ok: true });
		let entry = Store.get(questions, "w")!;
		let chosen = entry.model.clone();
		chosen.api.val(["q", "choice"]).set("b");
		let patch = chosen.api.flush();
		if (!patch) throw new Error("selection made no patch");
		expect(Store.edit(questions, "w", [...patch.toBinary()], "ana")).toMatchObject({
			accepted: true,
			applied: true,
		});
		expect(Store.suggest(questions, "w", { optionId: "a", messageIds: ["m1"] }))
			.toEqual({ ok: false, reason: "chosen" });
		expect(Question.read(entry.model, entry.definition).q!.choice).toBe("b");

		let fresh = asked();
		Store.addOption(fresh, "w", "b", "GitHub Apps");
		Store.suggest(fresh, "w", { optionId: "a", messageIds: ["m1"] });
		let suggested = Store.get(fresh, "w")!;
		let human = suggested.model.clone();
		human.api.val(["q", "choice"]).set("b");
		let humanPatch = human.api.flush();
		if (!humanPatch) throw new Error("selection made no patch");
		expect(Store.edit(fresh, "w", [...humanPatch.toBinary()], "ben")).toMatchObject({
			accepted: true,
			applied: true,
		});
		expect(Store.get(fresh, "w")!.suggested).toBeUndefined();
	});

	it("rejects unknown options, closed cards, and malformed stored sources", () => {
		let questions = asked();
		expect(Store.suggest(questions, "w", { optionId: "missing", messageIds: [] }))
			.toEqual({ ok: false, reason: "unknown" });
		expect(Store.suggest(questions, "missing", { optionId: "a", messageIds: [] }))
			.toEqual({ ok: false, reason: "closed" });
		expect(Store.suggest(questions, "w", { optionId: "a", messageIds: ["m1"] }))
			.toMatchObject({ ok: true });
		let stored = Store.dump(questions)[0]!;
		expect(() =>
			Store.restore([{
				...stored,
				suggested: {
					...stored.suggested!,
					optionId: "missing",
				},
			}])
		)
			.toThrow(/suggestion/);
		expect(() =>
			Store.restore([{
				...stored,
				suggested: { ...stored.suggested!, messageIds: ["x".repeat(201)] },
			}])
		).toThrow(/suggestion/);
		expect(() =>
			Store.restore([{
				...stored,
				suggested: {
					...stored.suggested!,
					revision: 0,
				},
			}])
		).toThrow(/suggestion/);
		let chosen = Store.get(questions, "w")!.model.clone();
		chosen.api.val(["q", "choice"]).set("a");
		expect(() =>
			Store.restore([{
				...stored,
				model: [...chosen.toBinary()],
			}])
		).toThrow(/suggestion/);
		expect(() =>
			Store.restore([{
				...stored,
				suggested: { ...stored.suggested!, extra: true },
			} as never])
		).toThrow(/suggestion/);
	});
});
