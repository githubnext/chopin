import { describe, expect, it } from "bun:test";
import * as Question from "@chopin/question";

import * as Store from "./store";

// legacy() and the original restoration callback: archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2,
// apps/server/src/questions/store.test.ts. Remaining archive Store callbacks are deferred.
function legacy() {
	return {
		questions: ["q1", "q2"].map(id => ({
			id,
			header: id,
			question: `${id}?`,
			multiple: false,
			options: [{ id: `${id}-a`, label: "One", description: "" }],
		})),
	};
}

describe("Store.restore shared definitions", () => {
	it("restores a legacy multi-question draft with its original question IDs", () => {
		let definition = legacy();
		let restored = Store.restore([{
			id: "w",
			definition,
			widget: "w",
			model: [...Question.create(definition).toBinary()],
			revision: 3,
		}]);
		expect(Store.snapshot(restored, "w")).toMatchObject({
			open: true,
			definition,
			revision: 3,
		});
		expect(Store.outstanding(restored)[0]?.definition).toEqual(definition);
	});
	it("restores an empty pending card without replacing its durable ID or draft mode", () => {
		let definition = {
			questions: [{
				id: "pending-question",
				header: "Choice",
				question: "Which option?",
				multiple: false,
				options: [],
			}],
		};
		let stored = {
			id: "pending-card",
			definition,
			model: [...Question.create(definition).toBinary()],
			revision: 7,
		};
		let restored = Store.restore([stored]);
		let entry = Store.get(restored, "pending-card")!;
		expect(entry.definition).toEqual(definition);
		expect(Question.read(entry.model, entry.definition)).toEqual({
			"pending-question": { mode: "choices", choice: null, custom: "", options: {} },
		});
		expect(Store.dump(restored)).toEqual([stored]);
	});

	it("rejects malformed stored definitions instead of only checking their question count", () => {
		let definition = { questions: [legacy().questions[0]!] };
		let model = [...Question.create(definition).toBinary()];
		for (
			let invalid of [
				{ ...definition, extra: true },
				{ questions: [{ ...definition.questions[0]!, multiple: "false" }] },
			]
		) {
			expect(() =>
				Store.restore([{
					id: "invalid",
					definition: invalid as Question.Definition,
					model,
					revision: 0,
				}])
			).toThrow(Question.QuestionError);
		}
	});
});
