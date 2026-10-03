import { expect, test } from "bun:test";

import { normalizeRecord, questionMentionsOption } from "./records";

test("question provenance requires the option's named terms, including D02 hosting labels", () => {
	let question = "hosting for the beta: managed app service or our own server?";
	expect(questionMentionsOption(question, "Use a managed app service")).toBe(true);
	expect(questionMentionsOption(question, "Host on our own server")).toBe(true);
	expect(questionMentionsOption(question, "Host on a small VPS")).toBe(false);
	expect(questionMentionsOption("Should we use GitHub Apps or OAuth?", "Redis")).toBe(false);
	expect(questionMentionsOption("Should we use GitHub Apps or OAuth?", "GitHub Apps")).toBe(true);
	expect(questionMentionsOption("Should we use GitHub Apps or OAuth?", "OAuth")).toBe(true);
	expect(questionMentionsOption("Should we use Auth0?", "Auth")).toBe(false);
});

let definition = {
	questions: [
		{
			id: "q1",
			header: "First",
			question: "First choice?",
			multiple: true,
			options: Array.from({ length: 12 }, (_, index) => ({
				id: `a${index}`,
				label: `A ${index}`,
				description: "",
			})),
		},
		{
			id: "q2",
			header: "Second",
			question: "Second choice?",
			multiple: true,
			options: Array.from({ length: 12 }, (_, index) => ({
				id: `b${index}`,
				label: `B ${index}`,
				description: "",
			})),
		},
	],
};

let base = {
	id: "w",
	definition,
	status: "reopened",
	origin: "planner",
	optionOrigins: {},
	editors: [],
};

test("an open conversation card can have no quoted options yet", () => {
	let pending = {
		...base,
		status: "open",
		origin: "conversation",
		threadId: "thread-a",
		definition: {
			questions: [{
				id: "q1",
				header: "Auth",
				question: "Which system?",
				multiple: false,
				options: [],
			}],
		},
	};
	expect(normalizeRecord(pending).definition.questions[0]?.options).toEqual([]);
	expect(normalizeRecord({ ...pending, status: "discarded" }).status).toBe("discarded");
	expect(() => normalizeRecord({ ...pending, status: "answered" })).toThrow(/invalid/);
	expect(() => normalizeRecord({ ...pending, origin: "planner" })).toThrow(/invalid/);
});

test("history accepts more than 20 choices across legacy questions", () => {
	let all = definition.questions.flatMap(question => question.options.map(option => option.id));
	let record = normalizeRecord({
		...base,
		history: [{ choices: all, owner: "ana", at: 1 }],
	});
	expect(record.history[0]?.choices).toEqual(all);
});

test("history retains a mixed ID and text answer without assigning an ID to the text", () => {
	let record = normalizeRecord({
		...base,
		history: [{ choices: ["a0"], answers: { q2: "A custom answer" }, owner: "ana", at: 1 }],
	});
	expect(record.history[0]).toEqual({
		choices: ["a0"],
		answers: { q2: "A custom answer" },
		owner: "ana",
		at: 1,
	});
});

test("history rejects overlap, missing answers, unknown IDs, and malformed text", () => {
	let invalid = [
		{ choices: ["a0"], answers: { q1: "Duplicate", q2: "Text" }, owner: "ana", at: 1 },
		{ choices: ["a0"], owner: "ana", at: 1 },
		{ choices: ["unknown"], answers: { q2: "Text" }, owner: "ana", at: 1 },
		{ choices: ["a0"], answers: { q2: "" }, owner: "ana", at: 1 },
		{ choices: ["a0"], answers: { q2: "x".repeat(4001) }, owner: "ana", at: 1 },
		{ choices: ["a0"], answers: { wrong: "Text" }, owner: "ana", at: 1 },
	];
	for (let entry of invalid) {
		expect(() => normalizeRecord({ ...base, history: [entry] })).toThrow(/invalid question record/);
	}
});

test("current choice bounds are checked per question", () => {
	let single = {
		...definition,
		questions: definition.questions.map((question, index) => ({
			...question,
			multiple: index !== 0,
		})),
	};
	expect(() =>
		normalizeRecord({
			...base,
			definition: single,
			choices: ["a0", "a1"],
		})
	).toThrow(/invalid question record/);
	expect(() =>
		normalizeRecord({
			...base,
			answers: { wrong: "Text" },
		})
	).toThrow(/invalid question record/);
});

test("option origins restore without a source and reject malformed optional sources", () => {
	let record = {
		...base,
		optionOrigins: { a0: { origin: "planner" as const, rationale: "Repository evidence" } },
	};
	expect(normalizeRecord(record).optionOrigins.a0).toEqual(record.optionOrigins.a0);
	let cited = {
		...record,
		optionOrigins: {
			a0: {
				origin: "planner" as const,
				source: {
					messageId: "m1",
					author: { kind: "member" as const, handle: "jev" },
					quote: "Lexical",
					start: 0,
					end: 7,
					role: "option" as const,
				},
			},
		},
	};
	expect(normalizeRecord(cited).optionOrigins.a0).toEqual(cited.optionOrigins.a0);
	let question = {
		...cited,
		origin: "conversation" as const,
		threadId: "thread-a",
		optionOrigins: {
			a0: {
				...cited.optionOrigins.a0,
				source: { ...cited.optionOrigins.a0.source, role: "question" as const },
			},
		},
	};
	expect(normalizeRecord(question).optionOrigins.a0).toEqual(question.optionOrigins.a0);
	expect(() => normalizeRecord({ ...question, origin: "planner" })).toThrow(
		/invalid question record/,
	);
	expect(() =>
		normalizeRecord({
			...cited,
			optionOrigins: {
				a0: {
					...cited.optionOrigins.a0,
					source: { ...cited.optionOrigins.a0.source, role: "reason" },
				},
			},
		})
	).toThrow(/invalid question record/);
});
