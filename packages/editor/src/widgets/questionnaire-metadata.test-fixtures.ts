// Exact archive446a9779a937fa5be7cd3eb52fd7f3023d691ed2 fixtures,
// packages/editor/src/widgets/questionnaire.test.tsx.
export const DECIDED = {
	id: "w",
	thread: "t",
	by: "ana",
	questions: [{
		id: "q",
		header: "Auth",
		prompt: "What auth system should we use?",
		multiple: false,
		options: [{ id: "a", label: "Auth0" }, { id: "b", label: "GitHub Apps" }],
		answer: "GitHub Apps",
		choices: ["b"],
	}],
};

export const META = {
	status: "decided" as const,
	origin: "conversation" as const,
	owner: "ana",
	involved: ["ana"],
	history: [],
	optionOrigins: {},
	hasProse: false,
	refining: false,
	proseOrphaned: false,
};
