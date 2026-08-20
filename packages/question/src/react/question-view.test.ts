import { expect, test } from "bun:test";

import { currentQuestion } from "./question-view";

test("a replacement definition falls back before rendering when its active question disappears", () => {
	let storage = {
		id: "storage",
		header: "Storage",
		question: "Where should room state live?",
		multiple: false,
		options: [],
	};
	let scope = {
		id: "scope",
		header: "Scope",
		question: "What belongs in the first cut?",
		multiple: false,
		options: [],
	};

	expect(currentQuestion({ questions: [storage, scope] }, "removed")).toBe(storage);
});
