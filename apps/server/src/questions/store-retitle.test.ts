import { describe, expect, it } from "bun:test";
import * as Question from "@chopin/question";

import * as Store from "./store";
import { asked } from "./store.test-fixtures";

// Original callbacks from archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2.
// Advisory retitle/editor/suggest callbacks are deferred to the next bounded slice.
describe("Store.retitle", () => {
	it("changes one decision question without changing the human draft or option identities", () => {
		let questions = asked();
		let entry = Store.get(questions, "w")!;
		let chosen = Question.crdt.Model.fromBinary(entry.model.toBinary())
			.fork() as unknown as Question.Model;
		chosen.api.val(["q", "choice"]).set("a");
		let patch = chosen.api.flush();
		if (!patch) throw new Error("selection made no patch");
		expect(Store.edit(questions, "w", [...patch.toBinary()], "ana")).toMatchObject({
			open: true,
			accepted: true,
		});
		entry = Store.get(questions, "w")!;
		let before = [...entry.model.toBinary()];
		let result = Store.retitle(questions, "w", " Which auth system should ship first? ");
		expect(result).toMatchObject({ ok: true, applied: true, revision: 2 });
		entry = Store.get(questions, "w")!;
		expect(entry.definition.questions[0]?.question).toBe("Which auth system should ship first?");
		expect(entry.definition.questions[0]?.options).toEqual([
			{ id: "a", label: "Auth0", description: "" },
		]);
		expect([...entry.model.toBinary()]).toEqual(before);
		expect(Question.read(entry.model, entry.definition).q?.choice).toBe("a");
		expect(Store.restore(Store.dump(questions)).open.get("w")?.revision).toBe(2);
	});

	it("refuses invalid text, a resolving decision, and a closed decision", () => {
		let questions = asked();
		expect(Store.retitle(questions, "w", " ")).toMatchObject({
			ok: false,
			reason: "invalid",
		});
		expect(Store.retitle(questions, "w", "x".repeat(1_001))).toMatchObject({
			ok: false,
			reason: "invalid",
		});
		let claim = Store.claimCancel(questions, "w", "ana");
		expect(Store.retitle(questions, "w", "Why now?")).toMatchObject({
			ok: false,
			reason: "closed",
		});
		if (!claim.ok) throw new Error("setup");
		Store.commit(questions, claim.claim);
		expect(Store.retitle(questions, "w", "Why now?")).toMatchObject({
			ok: false,
			reason: "closed",
		});
	});
});
