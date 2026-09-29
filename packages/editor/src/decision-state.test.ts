import { describe, expect, it } from "bun:test";

import {
	advanceDecisionView,
	countUnanswered,
	documentHasPlanningContent,
	firstOpenDecision,
	selectDecisionView,
	visibleDecisionView,
} from ".";

import type { DecisionViewState } from ".";
import type { Question } from "@chopin/protocol";

import type { QuestionnaireEntry } from "./questionnaires";

function entry(
	answers: Array<string | undefined>,
	status?: Question.CardMeta["status"],
): QuestionnaireEntry {
	return {
		id: String(answers.length),
		value: {
			id: String(answers.length),
			...(status ? { status } : {}),
			questions: answers.map((answer, index) => ({
				id: `q${index}`,
				header: `Question ${index + 1}`,
				prompt: `Question ${index + 1}?`,
				multiple: false,
				options: [],
				...(answer === undefined ? {} : { answer }),
			})),
		},
	};
}

function meta(status: Question.CardMeta["status"]): Question.CardMeta {
	return {
		status,
		origin: "planner",
		involved: [],
		history: [],
		optionOrigins: {},
		hasProse: false,
		refining: false,
		proseOrphaned: false,
	};
}

describe("decision attention", () => {
	it("counts unresolved questions rather than questionnaire cards", () => {
		expect(countUnanswered([entry([undefined, undefined]), entry(["Done"])]))
			.toBe(2);
	});

	it("excludes metadata-settled cards while preserving legacy multi-question counts", () => {
		let waiting = { ...entry([undefined, undefined]), id: "waiting" };
		let decided = { ...entry([undefined]), id: "decided" };
		let discarded = { ...entry([undefined]), id: "discarded" };
		let metadata = new Map([
			["decided", meta("decided")],
			["discarded", meta("discarded")],
		]);

		expect(countUnanswered([waiting, decided, discarded], metadata)).toBe(2);
	});

	it("counts every question when metadata reopens a card before its old projection updates", () => {
		let reopened = {
			...entry(["Earlier choice", "Earlier answer"]),
			id: "reopened",
		};
		expect(countUnanswered(
			[reopened],
			new Map([[
				"reopened",
				meta("reopened"),
			]]),
		)).toBe(2);
	});

	it("preserves unanswered question counts for partially answered open cards", () => {
		let open = { ...entry(["Earlier choice", undefined]), id: "open" };
		expect(countUnanswered(
			[open],
			new Map([[
				"open",
				meta("open"),
			]]),
		)).toBe(1);
	});

	it("uses persisted card status when metadata is unavailable", () => {
		expect(countUnanswered([
			entry([undefined, undefined], "open"),
			entry([undefined], "discarded"),
		])).toBe(2);
	});

	it("never waits on an expired questionnaire", () => {
		let waiting = entry([undefined]);
		let expired = { ...waiting, value: { ...waiting.value, status: "expired" as const } };
		expect(countUnanswered([expired, entry([undefined, undefined])])).toBe(2);
		expect(firstOpenDecision([expired])).toBeUndefined();
		expect(firstOpenDecision([waiting])).toBe(waiting);
	});

	it("forces only a questionnaire-only opening document into Decisions", () => {
		expect(visibleDecisionView({ phase: "initial", preferred: "plan" }, false, 2)).toBe(
			"decisions",
		);
		expect(visibleDecisionView({ phase: "initial", preferred: "plan" }, true, 2)).toBe("plan");
		expect(visibleDecisionView({ phase: "initial", preferred: "decisions" }, true, 0)).toBe(
			"decisions",
		);
	});

	it("keeps a chat-linked inline card in Document while Planner questions still open Decisions", () => {
		let plannerQuestion = entry([undefined]);
		let conversationQuestion = entry([undefined]);
		conversationQuestion.value = { ...conversationQuestion.value, thread: "thread-1" };
		let initial: DecisionViewState = { phase: "initial", preferred: "plan" };
		let plannerHasContent = documentHasPlanningContent(false, [plannerQuestion]);
		let conversationHasContent = documentHasPlanningContent(false, [conversationQuestion]);

		expect(visibleDecisionView(
			initial,
			plannerHasContent,
			countUnanswered([plannerQuestion]),
		)).toBe("decisions");
		expect(visibleDecisionView(
			initial,
			conversationHasContent,
			countUnanswered([conversationQuestion]),
		)).toBe("plan");

		let state = advanceDecisionView(
			initial,
			plannerHasContent,
			countUnanswered([plannerQuestion]),
		);
		expect(state.phase).toBe("forced");
		state = advanceDecisionView(
			state,
			conversationHasContent,
			countUnanswered([plannerQuestion, conversationQuestion]),
		);
		expect(state).toEqual({ phase: "complete", preferred: "plan" });
	});

	it.each(["plan", "decisions"] as const)(
		"keeps a saved %s preference out of an opening transition until prose exists",
		preference => {
			let state: DecisionViewState = { phase: "initial", preferred: preference };
			state = advanceDecisionView(state, false, 2);
			expect(visibleDecisionView(state, false, 2)).toBe("decisions");
			state = advanceDecisionView(state, false, 0);
			expect(visibleDecisionView(state, false, 0)).toBe("decisions");
			state = advanceDecisionView(state, true, 0);
			expect(state).toEqual({ phase: "complete", preferred: "plan" });
			expect(visibleDecisionView(state, true, 0)).toBe("plan");
			expect(visibleDecisionView({ ...state, preferred: preference }, true, 0)).toBe(preference);
		},
	);

	it.each(["plan", "decisions"] as const)(
		"does not re-enter forced Decisions after opening prose is removed with a saved %s preference",
		preference => {
			let state: DecisionViewState = { phase: "initial", preferred: preference };
			state = advanceDecisionView(state, false, 2);
			state = advanceDecisionView(state, false, 0);
			state = advanceDecisionView(state, true, 0);
			state = advanceDecisionView(state, false, 1);
			expect(state).toEqual({ phase: "complete", preferred: "plan" });
			expect(visibleDecisionView(state, false, 1)).toBe("plan");
			expect(visibleDecisionView({ ...state, preferred: preference }, false, 1)).toBe(preference);
		},
	);

	it("lets explicit Document navigation override a forced Decisions opening", () => {
		let state = advanceDecisionView(
			{ phase: "initial", preferred: "plan" },
			false,
			2,
		);

		state = selectDecisionView(state, "plan");

		expect(state).toEqual({ phase: "complete", preferred: "plan" });
		expect(visibleDecisionView(state, false, 2)).toBe("plan");
	});
});

describe("Decisions opening target", () => {
	it.each(["decided", "discarded"] as const)(
		"skips metadata-%s cards with stale unanswered definitions",
		status => {
			let settled = { ...entry([undefined]), id: "settled" };
			let open = { ...entry([undefined]), id: "open" };
			let metadata = new Map([[settled.id, meta(status)]]);

			expect(firstOpenDecision([settled, open], metadata)?.id).toBe("open");
		},
	);

	it("reveals the first metadata-reopened card despite its previous answers", () => {
		let reopened = { ...entry(["Previous answer"], "decided"), id: "reopened" };
		let open = { ...entry([undefined]), id: "open" };
		let metadata = new Map([[reopened.id, meta("reopened")]]);

		expect(firstOpenDecision([reopened, open], metadata)?.id).toBe("reopened");
	});

	it("lets settled metadata override a persisted reopened status", () => {
		let settled = { ...entry([undefined], "reopened"), id: "settled" };
		let open = { ...entry([undefined]), id: "open" };
		let metadata = new Map([[settled.id, meta("decided")]]);

		expect(firstOpenDecision([settled, open], metadata)?.id).toBe("open");
	});

	it("uses persisted statuses without metadata in document order", () => {
		let discarded = { ...entry([undefined], "discarded"), id: "discarded" };
		let reopened = { ...entry(["Previous answer"], "reopened"), id: "reopened" };
		let open = { ...entry([undefined], "open"), id: "open" };

		expect(firstOpenDecision([discarded, reopened, open])?.id).toBe("reopened");
		expect(firstOpenDecision([open, reopened])?.id).toBe("open");
	});

	it("preserves partially answered legacy multi-question cards", () => {
		let decided = { ...entry(["Done"]), id: "decided" };
		let partial = { ...entry(["Done", undefined]), id: "partial" };
		let open = { ...entry([undefined]), id: "open" };

		expect(firstOpenDecision([decided, partial, open])?.id).toBe("partial");
	});

	it("returns no target for empty or entirely settled documents", () => {
		let decided = { ...entry(["Done"]), id: "decided" };
		let discarded = { ...entry([undefined], "discarded"), id: "discarded" };

		expect(firstOpenDecision([])).toBeUndefined();
		expect(firstOpenDecision([decided, discarded])).toBeUndefined();
	});
});
