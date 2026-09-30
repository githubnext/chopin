import { expect, test } from "bun:test";
import type { ConversationPlan } from "@chopin/protocol";
import {
	assertStateShape,
	MAX_ANALYSIS,
	MAX_EVENTS,
	MAX_QUEUE,
	MAX_RESEARCH_OFFERS,
	MAX_THREADS,
} from "./validation";

function state(): ConversationPlan.State {
	return { schemaVersion: 1, revision: 0, events: [], threads: [], queue: [], analysis: [] };
}

test("the empty version-one snapshot validates without adding stored fields", () => {
	let snapshot = state();
	let before = structuredClone(snapshot);
	expect(() => assertStateShape(snapshot)).not.toThrow();
	expect(snapshot).toEqual(before);
	expect(() => assertStateShape({ ...snapshot, schemaVersion: 2 })).toThrow(
		"unsupported conversation plan schema",
	);
});

function analysis(): ConversationPlan.AnalysisRecord {
	return {
		messageId: "message-1",
		questionSetVersion: "questions-1",
		modelVersion: "fixture",
		status: "applied",
		passes: [],
		eventIds: [],
	};
}
function withAnswer(answer: unknown) {
	return {
		...state(),
		analysis: [{ ...analysis(), passes: [{ stage: "triage", answers: { flag: answer } }] }],
	};
}

test("snapshot array bounds and revision reject malformed saved containers", () => {
	for (
		let [field, maximum] of [
			["events", MAX_EVENTS],
			["threads", MAX_THREADS],
			["queue", MAX_QUEUE],
			["analysis", MAX_ANALYSIS],
		] as const
	) {
		expect(() =>
			assertStateShape({ ...state(), [field]: Array.from({ length: maximum + 1 }, () => null) })
		)
			.toThrow("invalid conversation plan snapshot arrays");
		expect(() => assertStateShape({ ...state(), [field]: {} })).toThrow(
			"invalid conversation plan snapshot arrays",
		);
	}
	expect(() =>
		assertStateShape({
			...state(),
			researchOffers: Array.from({ length: MAX_RESEARCH_OFFERS + 1 }, () => null),
		})
	)
		.toThrow("invalid research offers array");
	expect(() => assertStateShape({ ...state(), revision: -1 })).toThrow(/version/);
	expect(() => assertStateShape({ ...state(), extra: true })).toThrow(/unknown/);
});

test("queued messages retain unique IDs and bounded attempts and errors", () => {
	let queued = { messageId: "message-1", status: "pending", attempts: 0 };
	expect(() => assertStateShape({ ...state(), queue: [queued] })).not.toThrow();
	expect(() => assertStateShape({ ...state(), queue: [queued, queued] })).toThrow(
		"duplicate queued message",
	);
	for (
		let fields of [{ status: "unknown" }, { attempts: -1 }, { error: "x".repeat(301) }, {
			extra: true,
		}]
	) {
		expect(() => assertStateShape({ ...state(), queue: [{ ...queued, ...fields }] })).toThrow();
	}
});

test("raw analysis probabilities, winning choices, and weighted scores validate", () => {
	let choice = {
		type: "choice",
		choice: "save",
		confidence: 0.8,
		probabilities: { save: 0.8, skip: 0.2 },
	};
	let score = {
		type: "score",
		score: 0.75,
		confidence: 0.9,
		legend: { "0": "Low", "1": "High" },
		probabilities: { "0": 0.25, "1": 0.75 },
	};
	for (let answer of [{ type: "noul", noul: 0.5 }, choice, score]) {
		expect(() => assertStateShape(withAnswer(answer))).not.toThrow();
	}
	for (
		let answer of [
			{ type: "noul", noul: Number.NaN },
			{ type: "noul", noul: 1.1 },
			{ ...choice, choice: "skip" },
			{ ...choice, probabilities: { save: 0.1, skip: 0.2 } },
			{ ...choice, probabilities: { save: 1 } },
			{ ...choice, confidence: -1 },
			{ ...score, score: 0.1 },
			{ ...score, legend: { "1": "Low", "2": "High" } },
			{ ...score, probabilities: { "0": 0.25, "2": 0.75 } },
			{ type: "noul", noul: 0.5, extra: true },
		]
	) expect(() => assertStateShape(withAnswer(answer))).toThrow();
});

test("analysis pass order, question counts, and aggregate distributions stay bounded", () => {
	let passes = [
		{ stage: "triage", answers: {} },
		{ stage: "targeting", answers: {} },
		{ stage: "clarification", version: "bare-editor-clarification-1", answers: {} },
	];
	expect(() => assertStateShape({ ...state(), analysis: [{ ...analysis(), passes }] })).not
		.toThrow();
	expect(() => assertStateShape({ ...state(), analysis: [{ ...analysis(), passes: [passes[2]] }] }))
		.toThrow(/clarification/);
	let answers = Object.fromEntries(
		Array.from({ length: 46 }, (_, index) => [`q${index}`, { type: "noul", noul: 0.5 }]),
	);
	expect(() =>
		assertStateShape({
			...state(),
			analysis: [{ ...analysis(), passes: [{ stage: "triage", answers }] }],
		})
	).toThrow("too many analysis questions");
	let probabilities = Object.fromEntries(
		Array.from({ length: 200 }, (_, index) => [`option${index}`, 0.005]),
	);
	let manyAnswers = Object.fromEntries(
		Array.from(
			{ length: 3 },
			(
				_,
				index,
			) => [`q${index}`, { type: "choice", choice: "option0", confidence: 0.005, probabilities }],
		),
	);
	expect(() =>
		assertStateShape({
			...state(),
			analysis: [{ ...analysis(), passes: [{ stage: "triage", answers: manyAnswers }] }],
		})
	).toThrow("too many analysis answer entries");
});

test("candidate outcome event IDs must belong to the analysis record", () => {
	let record = {
		...analysis(),
		eventIds: ["event-1"],
		outcomes: [{ start: 0, end: 3, status: "accepted", gate: "fixture", eventIds: ["event-1"] }],
	};
	expect(() => assertStateShape({ ...state(), analysis: [record] })).not.toThrow();
	expect(() => assertStateShape({ ...state(), analysis: [{ ...record, eventIds: [] }] }))
		.toThrow("candidate outcome event is not accepted");
	expect(() =>
		assertStateShape({
			...state(),
			analysis: [{ ...record, outcomes: [{ ...record.outcomes[0], end: 0 }] }],
		})
	)
		.toThrow("invalid candidate outcome");
	expect(() =>
		assertStateShape({
			...state(),
			analysis: [{ ...analysis(), quoteValidation: [{ start: 0, end: 3, valid: "yes" }] }],
		})
	)
		.toThrow("invalid quote validation debug");
});

function offer(index: number): ConversationPlan.ResearchOffer {
	return {
		id: `offer-${index}`,
		needId: `need-${index}`,
		contextId: "context-1",
		source: {
			messageId: `message-${index}`,
			author: { kind: "member", handle: "maggie" },
			quote: "Costs",
			start: 0,
			end: 5,
		},
		brief: "Costs",
		status: "offered",
	};
}

test("snapshot research identity guards duplicate offers, sources, needs, and actions", () => {
	let first = offer(1);
	let second = offer(2);
	expect(() => assertStateShape({ ...state(), researchOffers: [first, second] })).not.toThrow();
	for (
		let changed of [
			{ ...second, id: first.id },
			{ ...second, source: first.source },
			{ ...second, needId: first.needId },
		]
	) {
		expect(() => assertStateShape({ ...state(), researchOffers: [first, changed] })).toThrow(
			"duplicate research offer identity",
		);
	}
	let action: ConversationPlan.ResearchAction = {
		id: "action-1",
		kind: "research",
		actor: { kind: "member", handle: "maggie" },
		principalId: "principal-1",
		at: 1,
	};
	expect(() =>
		assertStateShape({
			...state(),
			researchOffers: [{ ...first, status: "accepted", action }, {
				...second,
				status: "accepted",
				action,
			}],
		})
	)
		.toThrow("duplicate research offer identity");
	expect(() =>
		assertStateShape({ ...state(), researchOffers: [{ ...first, threadId: "missing" }] })
	)
		.toThrow("research offer thread is missing");
});
