import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
	ActivityLine,
	DecisionPrompt,
	objectors,
	promptSelection,
	promptView,
} from "./decision-entry";

import type { Questionnaire } from "@chopin/dialect";
import type { Definition, Drafts } from "@chopin/question";
import type { Chat, ConversationPlan, Question } from "@chopin/protocol";

const VALUE: Questionnaire = {
	id: "Q",
	by: "mina",
	questions: [{
		id: "auth",
		header: "Auth",
		prompt: "What auth system should we use?",
		multiple: false,
		options: [
			{ id: "a", label: "Auth0" },
			{ id: "b", label: "GitHub Apps" },
		],
	}],
};

const DEFINITION: Definition = {
	questions: [{
		id: "auth",
		header: "Auth",
		question: "What auth system should we use?",
		multiple: false,
		options: [
			{ id: "a", label: "Auth0", description: "" },
			{ id: "b", label: "GitHub Apps", description: "" },
		],
	}],
};

const EMPTY_DRAFTS: Drafts = {
	auth: { mode: "choices", choice: null, options: { a: false, b: false }, custom: "" },
};

function openMeta(overrides: Partial<Question.CardMeta> = {}): Question.CardMeta {
	return {
		status: "open",
		origin: "conversation",
		involved: [],
		history: [],
		optionOrigins: {},
		hasProse: false,
		refining: false,
		proseOrphaned: false,
		...overrides,
	};
}

function promptEntry(generation: number, ts = 10): Chat.Entry & {
	author: { kind: "system" };
	decision: { questionnaireId: string; kind: "prompt"; generation: number };
} {
	return {
		id: `prompt-${generation}`,
		author: { kind: "system" },
		text: "Ready to decide: What auth system should we use?",
		ts,
		decision: { questionnaireId: "Q", kind: "prompt", generation },
	};
}

test("the current prompt generation stays live across a same-second reopen", () => {
	let savedValue = {
		...VALUE,
		status: "decided" as const,
		questions: [{ ...VALUE.questions[0]!, answer: "GitHub Apps", choices: ["b"] }],
	};
	let saved = openMeta({
		status: "decided",
		history: [{ choices: ["b"], owner: "mina", at: 10 }],
	});
	let reopened = { ...saved, status: "reopened" as const };

	expect(promptView({ entry: promptEntry(0), latest: true, meta: saved, value: savedValue }))
		.toEqual({ state: "collapsed", text: "Decided: GitHub Apps · @mina" });
	expect(promptView({ entry: promptEntry(0), latest: true, meta: reopened, value: savedValue }))
		.toEqual({ state: "collapsed", text: "Reopened" });
	expect(promptView({ entry: promptEntry(0), latest: false, meta: reopened, value: savedValue }))
		.toEqual({ state: "collapsed", text: "Reopened" });
	expect(promptView({ entry: promptEntry(1), latest: false, meta: reopened, value: savedValue }))
		.toEqual({ state: "collapsed", text: "Superseded by a later prompt" });
	expect(promptView({ entry: promptEntry(1), latest: true, meta: reopened, value: savedValue }))
		.toEqual({ state: "live" });
});

test("old, missing, and superseded prompt state cannot stay live", () => {
	let meta = openMeta({ history: [{ choices: ["b"], owner: "mina", at: 10 }] });

	expect(promptView({ entry: promptEntry(0), latest: true, meta, value: VALUE }))
		.toEqual({ state: "collapsed", text: "Decision changed" });
	expect(promptView({ entry: promptEntry(1), latest: false, meta, value: VALUE }))
		.toEqual({ state: "collapsed", text: "Superseded by a later prompt" });
	expect(promptView({ entry: promptEntry(0), latest: true, value: VALUE }))
		.toEqual({ state: "collapsed", text: "Decision unavailable" });
	expect(promptView({ entry: promptEntry(0), latest: true, meta }))
		.toEqual({ state: "collapsed", text: "Decision unavailable" });
	expect(promptView({ entry: promptEntry(1), latest: true, meta: openMeta(), value: VALUE }))
		.toEqual({ state: "collapsed", text: "Decision changed" });
});

test("a decision without labels uses its saved-answer fallback and owner", () => {
	let custom = {
		...VALUE,
		questions: [{ ...VALUE.questions[0]!, answer: "Use the hosted provider", choices: undefined }],
	};
	let meta = openMeta({ status: "decided", owner: "jules" });
	expect(promptView({ entry: promptEntry(0), latest: true, meta, value: custom }))
		.toEqual({ state: "collapsed", text: "Decided: Use the hosted provider · @jules" });
	let unanswered = { ...custom, questions: [{ ...custom.questions[0]!, answer: undefined }] };
	expect(promptView({ entry: promptEntry(0), latest: true, meta, value: unanswered }))
		.toEqual({ state: "collapsed", text: "Decided: Saved decision · @jules" });
});

test("prompt selection shares the card projection and exact suggestion snapshot", () => {
	let suggested = { optionId: "b", revision: 7 };
	let projection = promptSelection(DEFINITION, EMPTY_DRAFTS, suggested);
	expect(projection).toEqual({
		optionId: "b",
		label: "GitHub Apps",
		visibleSuggestion: suggested,
	});
	expect(projection.visibleSuggestion).toBe(suggested);

	let human = promptSelection(DEFINITION, {
		auth: { ...EMPTY_DRAFTS.auth!, choice: "a" },
	}, suggested);
	expect(human).toEqual({ optionId: "a", label: "Auth0" });

	let moved = promptSelection(
		{
			questions: [{
				...DEFINITION.questions[0]!,
				options: [DEFINITION.questions[0]!.options[0]!],
			}],
		},
		EMPTY_DRAFTS,
		suggested,
	);
	expect(moved).toEqual({});
});

test("prompt selection does not change multi-question or multi-select cards", () => {
	let multipleChoice: Definition = {
		questions: [{ ...DEFINITION.questions[0]!, multiple: true }],
	};
	let multipleQuestions: Definition = {
		questions: [DEFINITION.questions[0]!, { ...DEFINITION.questions[0]!, id: "scope" }],
	};
	let suggestion = { optionId: "b", revision: 7 };
	expect(promptSelection(multipleChoice, EMPTY_DRAFTS, suggestion)).toEqual({});
	expect(promptSelection(multipleQuestions, EMPTY_DRAFTS, suggestion)).toEqual({});
});

test("a live prompt points to the card instead of offering a second Save", () => {
	let markup = renderToStaticMarkup(createElement(DecisionPrompt, {
		entry: promptEntry(0),
		latest: true,
		value: VALUE,
		meta: openMeta({ suggested: { optionId: "b", messageIds: ["m2"], revision: 7 } }),
		connected: true,
		canEdit: true,
		onOpenCard() {},
	}));
	let text = markup.replace(/<[^>]*>/g, "");

	expect(text).toBe("Ready to settle: GitHub Apps · Open card");
	expect(markup).not.toContain("Save");
	expect(markup).toContain('aria-label="Open card: What auth system should we use?"');
	expect(markup).toMatch(/aria-label="Decision prompt: What auth system should we use\?"/);
	expect(markup).not.toContain("<img");
});

function stance(
	participant: string,
	position: ConversationPlan.Stance["position"],
	optionId?: string,
): ConversationPlan.Stance {
	return { id: `${participant}-${optionId}`, participant, position, optionId, sources: [], at: 1 };
}

test("without a selection the prompt asks for a choice and counts objecting people", () => {
	let markup = renderToStaticMarkup(createElement(DecisionPrompt, {
		entry: promptEntry(0),
		latest: true,
		value: VALUE,
		meta: openMeta(),
		connected: false,
		canEdit: false,
		stances: [stance("cy", "oppose", "a"), stance("cy", "oppose", "b")],
		onOpenCard() {},
	}));
	expect(markup.replace(/<[^>]*>/g, "")).toBe("Needs a choice · 1 objection · Open card");
	expect(markup).toMatch(/class="text-warning-ink">1 objection</);
	expect(markup).toContain('class="whitespace-nowrap">· <button');
});

test("objections count distinct people on the shown option or the whole decision", () => {
	let stances = [
		stance("cy", "oppose", "a"),
		stance("cy", "oppose", "b"),
		stance("di", "oppose"),
		stance("ed", "oppose", "a"),
		stance("fa", "support", "b"),
	];
	expect(objectors(stances, "b")).toBe(2);
	expect(objectors(stances, "a")).toBe(3);
	expect(objectors(stances, undefined)).toBe(3);
	expect(objectors([], "b")).toBe(0);

	let markup = renderToStaticMarkup(createElement(DecisionPrompt, {
		entry: promptEntry(0),
		latest: true,
		value: VALUE,
		meta: openMeta({ suggested: { optionId: "b", messageIds: ["m2"], revision: 7 } }),
		connected: true,
		canEdit: true,
		stances,
		onOpenCard() {},
	}));
	expect(markup.replace(/<[^>]*>/g, ""))
		.toBe("Ready to settle: GitHub Apps · 2 objections · Open card");
});

test("a collapsed prompt keeps its outcome and the card link", () => {
	let markup = renderToStaticMarkup(createElement(DecisionPrompt, {
		entry: promptEntry(0),
		latest: true,
		value: { ...VALUE, status: "decided", questions: [{ ...VALUE.questions[0]!, choices: ["b"] }] },
		meta: openMeta({ status: "decided", owner: "mina" }),
		connected: true,
		canEdit: true,
		stances: [stance("cy", "oppose")],
		onOpenCard() {},
	}));
	expect(markup.replace(/<[^>]*>/g, "")).toBe("Decided: GitHub Apps · @mina · Open card");
	expect(markup).not.toContain('role="group"');
});

test("activity labels remain text for the document sentinel and link card activities", () => {
	let documentActivity = renderToStaticMarkup(createElement(ActivityLine, {
		entry: {
			id: "heading-activity",
			author: { kind: "system" },
			text: "Chopin refined the document heading",
			ts: 10,
			decision: { questionnaireId: "document", kind: "activity", label: "the document heading" },
		},
		latest: true,
		connected: true,
		canEdit: true,
		onOpenCard() {},
	}));
	expect(documentActivity).toContain("the document heading");
	expect(documentActivity).not.toMatch(/<button[^>]*>the document heading<\/button>/);

	let cardActivity = renderToStaticMarkup(createElement(ActivityLine, {
		entry: {
			id: "card-activity",
			author: { kind: "system" },
			text: "Chopin refined What auth system should we use?",
			ts: 10,
			decision: {
				questionnaireId: "Q",
				kind: "activity",
				label: "What auth system should we use?",
			},
		},
		latest: true,
		connected: true,
		canEdit: true,
		onOpenCard() {},
	}));
	expect(cardActivity).toMatch(/<button[^>]*>What auth system should we use\?<\/button>/);
});

test("activity text stays exact when its label is interior or absent", () => {
	let interior = renderToStaticMarkup(createElement(ActivityLine, {
		entry: {
			id: "card-activity",
			author: { kind: "system" },
			text: "Chopin linked the architecture note to the auth card",
			ts: 10,
			decision: { questionnaireId: "Q", kind: "activity", label: "architecture note" },
		},
		latest: true,
		connected: true,
		canEdit: true,
		onOpenCard() {},
	}));
	expect(interior).toMatch(
		/Chopin linked the <button[^>]*>architecture note<\/button> to the auth card/,
	);
	expect(interior.match(/architecture note/g)).toHaveLength(1);

	let absent = renderToStaticMarkup(createElement(ActivityLine, {
		entry: {
			id: "heading-activity",
			author: { kind: "system" },
			text: "Chopin drafted the title and goal",
			ts: 10,
			decision: { questionnaireId: "document", kind: "activity", label: "the document" },
		},
		latest: true,
		connected: true,
		canEdit: true,
		onOpenCard() {},
	}));
	expect(absent).toContain("Chopin drafted the title and goal");
	expect(absent).not.toContain("the document");
});
