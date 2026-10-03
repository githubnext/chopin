import { expect, test } from "bun:test";
import type { ConversationPlan } from "@chopin/protocol";
import * as Question from "@chopin/question";
import { initialState } from "./domain";
import { effectsFor, recoverable } from "./effects";
import { event, LATER, OPTION, thread } from "./effects.test-fixtures";

// Whole callbacks from archive446a9779a937fa5be7cd3eb52fd7f3023d691ed2, effects.test.ts.
test("an opened thread inserts only card-valid quoted options; legacy recovery stays empty", () => {
	let open = event("thread.opened", "open-1", { question: "Which auth system?" });
	let state = { ...initialState(), threads: [thread()] };
	expect(effectsFor([open], state)).toMatchObject([{
		key: "insert:t1",
		kind: "insert-card",
		options: [{ id: OPTION, label: "GitHub Apps" }],
	}]);
	let old = thread({
		contributions: [{
			...thread().contributions[0],
			id: "classifier:historical",
		}],
	});
	let legacy = { ...initialState(), events: [open], threads: [old] };
	expect(recoverable(legacy)).toEqual([open]);
	expect(effectsFor(recoverable(legacy), legacy)[0]).toMatchObject({ options: [] });
});

test("card labels use the same bound on initial and later quoted options", () => {
	let quote = "A".repeat(Question.limits.MAX_LABEL + 30);
	let initial = thread({ contributions: [{ ...thread().contributions[0], text: quote }] });
	let state = { ...initialState(), threads: [initial] };
	let opened = event("thread.opened", "open-long");
	let added = event("option.added", "add-long", {
		contribution: { id: LATER, text: quote, authoring: "quoted" },
	});
	expect(effectsFor([opened], state)[0]).toMatchObject({
		options: [{ id: OPTION, label: "A".repeat(Question.limits.MAX_LABEL) }],
	});
	expect(effectsFor([added], state)[0]).toMatchObject({
		label: "A".repeat(Question.limits.MAX_LABEL),
	});
	let spaced = ` ${" ".repeat(Question.limits.MAX_LABEL)}GitHub Apps `;
	let spacedThread = thread({
		question: `${" ".repeat(Question.limits.MAX_HEADER)}Which auth system?`,
		contributions: [{ ...thread().contributions[0], text: spaced }],
	});
	let spacedState = { ...initialState(), threads: [spacedThread] };
	expect(effectsFor([opened], spacedState)[0]).toMatchObject({
		header: "Which auth system?",
		options: [{ id: OPTION, label: "GitHub Apps" }],
	});
	let spacedAdded = event("option.added", "add-spaced", {
		contribution: { id: LATER, text: spaced, authoring: "quoted" },
	});
	expect(effectsFor([spacedAdded], spacedState)[0]).toMatchObject({ label: "GitHub Apps" });
});

test("a pre-link option waits; link makes a separate refine job", () => {
	let source: ConversationPlan.SourceRef = {
		messageId: "option-message",
		author: { kind: "member", handle: "jules" },
		quote: "Auth0",
		start: 0,
		end: 5,
		role: "option",
	};
	let option = event("option.added", "option-2", {
		source,
		contribution: { id: LATER, text: "Auth0", authoring: "quoted" },
	});
	let unlinked = { ...initialState(), threads: [thread()] };
	expect(effectsFor([option], unlinked).map(item => item.kind)).toEqual(["add-option"]);
	let linked = {
		...initialState(),
		threads: [thread({
			questionnaireId: "Q",
			questionSources: [{ ...source, role: "question", messageId: "question-message" }],
		})],
	};
	expect(effectsFor([option], linked).map(item => item.kind)).toEqual([
		"add-option",
		"job",
	]);
	expect(effectsFor([event("card.linked", "link-1", { questionnaireId: "Q" })], linked))
		.toMatchObject([{ key: "job:refine:Q", kind: "job", intent: { kind: "refine" } }]);
});

test("sourced Planner chat options reach linked cards; source-free card options do not", () => {
	let linked = { ...initialState(), threads: [thread({ questionnaireId: "Q" })] };
	let quoted = event("option.added", "planner-quoted", {
		origin: "planner",
		actor: { kind: "agent" },
		source: {
			messageId: "agent-message",
			author: { kind: "agent" },
			quote: "Auth0",
			start: 0,
			end: 5,
			role: "option",
		},
		contribution: { id: LATER, text: "Auth0", authoring: "quoted" },
	});
	let cardTool = event("option.added", "planner-card", {
		origin: "planner",
		actor: { kind: "agent" },
		contribution: { id: LATER, text: "Auth0", authoring: "scribe" },
	});
	expect(effectsFor([quoted], linked).map(item => item.kind)).toEqual(["add-option", "job"]);
	expect(effectsFor([cardTool], linked)).toEqual([]);
});

test("new card jobs retain their event receipt but trigger from the source chat message", () => {
	let source = {
		messageId: "original-question",
		author: { kind: "member" as const, handle: "jules" },
		quote: "Which auth system?",
		start: 0,
		end: 18,
		role: "question" as const,
	};
	let linked = {
		...initialState(),
		threads: [thread({ questionnaireId: "Q", questionSources: [source] })],
	};
	expect(effectsFor([event("card.linked", "link-event", { questionnaireId: "Q" })], linked))
		.toMatchObject([{
			key: "job:refine:Q",
			intent: { kind: "refine", trigger: "original-question" },
		}]);
	let quoted = event("option.added", "option-event", {
		source: { ...source, messageId: "option-message", role: "option" },
		contribution: { id: LATER, text: "Auth0", authoring: "quoted" },
	});
	expect(effectsFor([quoted], linked)[1]).toMatchObject({
		key: "job:suggest:Q:option-event",
		intent: { kind: "suggest", trigger: "option-message" },
	});
});

test("unlinked purpose creates one heading intent without a thread event", () => {
	let analysis = {
		messageId: "m1",
		questionSetVersion: "conversation-plan-8",
		modelVersion: "jev",
		status: "unlinked",
		eventIds: [],
		passes: [{ stage: "triage", answers: { enough_purpose: { type: "noul", noul: 0.75 } } }],
	} as ConversationPlan.AnalysisRecord;
	expect(effectsFor([], initialState(), analysis)).toMatchObject([{
		key: "job:heading:document",
		kind: "job",
		intent: { kind: "heading", target: "document", trigger: "m1" },
	}]);
	expect(effectsFor([], initialState(), {
		...analysis,
		questionSetVersion: "conversation-plan-4",
	})).toMatchObject([{ key: "job:heading:document" }]);
	expect(
		effectsFor([], initialState(), { ...analysis, questionSetVersion: "conversation-plan-3" }),
	)
		.toEqual([]);
	expect(effectsFor([], initialState(), {
		...analysis,
		passes: [{ stage: "triage", answers: { enough_purpose: { type: "noul", noul: 0.749 } } }],
	})).toEqual([]);
});

test("new settle and leaning events do not target historical non-ULID options", () => {
	let oldId = "classifier:historical-option";
	let state = {
		...initialState(),
		threads: [thread({
			contributions: [{ ...thread().contributions[0], id: oldId }],
		})],
	};
	expect(effectsFor([event("settle.suggested", "settle-1", { optionId: oldId })], state))
		.toEqual([]);
	expect(effectsFor([event("thread.leaning", "lean-1", { optionId: oldId })], state))
		.toEqual([]);
});
