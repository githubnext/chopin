import * as Question from "@chopin/question";

import * as Store from "./store";

// Exact archive helpers: 446a9779a937fa5be7cd3eb52fd7f3023d691ed2,
// apps/server/src/questions/store.test.ts.
export function asked() {
	let questions = Store.create();
	let definition = Question.decision({
		questions: [{
			id: "q",
			header: "Auth",
			question: "What auth system should we use?",
			multiple: false,
			options: [{ id: "a", label: "Auth0", description: "" }],
		}],
	});
	void Store.ask(questions, "w", definition, "w");
	return questions;
}

export function legacy() {
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
