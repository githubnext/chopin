import { describe, expect, it } from "bun:test";
import { ulid } from "@chopin/dialect";
import * as room from "./room";
import { questionnaire } from "./card-projections.test-fixtures";

describe("questionnaire answer projection", () => {
	it("writes chosen option identifiers beside the answer summary", async () => {
		let document = await room.create();
		let card = questionnaire(ulid(), ulid(), ulid(), "Auth");
		room.insertQuestionnaire(document, card);
		let question = card.questions[0]!;

		let mutation = room.projectAnswer(
			document,
			card.id,
			{ [question.id]: "Choose this" },
			undefined,
			{ [question.id]: [question.options[0]!.id] },
		);

		expect(mutation?.source).toContain(
			`<Answer value="Choose this" choices="${question.options[0]!.id}"`,
		);
		let custom = room.projectAnswer(document, card.id, { [question.id]: "Something else" });
		expect(custom?.source).toContain('<Answer value="Something else"');
		expect(custom?.source).not.toContain("choices=");
	});

	it("sets decided status without discarding the previous decision", async () => {
		let document = await room.create();
		let card = questionnaire(ulid(), ulid(), ulid(), "Auth");
		let question = card.questions[0]!;
		let previous = { choices: [question.options[0]!.id], by: "ana", at: "2026-09-23" };
		room.insertQuestionnaire(document, {
			...card,
			status: "reopened",
			questions: [{ ...question, previous }],
		});
		let mutation = room.projectAnswer(
			document,
			card.id,
			{ [question.id]: "Choose this" },
			{ by: "ben", at: "2026-09-25" },
			{ [question.id]: [question.options[0]!.id] },
		);
		expect(mutation?.source).toContain('status="decided"');
		expect(mutation?.source).toContain("<Previous");
		expect(mutation?.source).toContain('by="ana"');
	});

	it("refuses a missing or ambiguous answer target", async () => {
		let document = await room.create();
		expect(() => room.projectAnswer(document, ulid(), {})).toThrow(/Card is not available/);
		let card = questionnaire(ulid(), ulid(), ulid(), "First");
		room.insertQuestionnaires(document, [
			{ value: card },
			{ value: questionnaire(card.id, ulid(), ulid(), "Second") },
		]);
		let before = room.project(document);
		expect(() => room.projectAnswer(document, card.id, {})).toThrow(/Card is not available/);
		expect(room.project(document)).toBe(before);
	});

	it("refuses an answer whose question differs from the card", async () => {
		let document = await room.create();
		let card = questionnaire(ulid(), ulid(), ulid(), "First");
		room.insertQuestionnaire(document, card);
		let before = room.project(document);
		expect(() => room.projectAnswer(document, card.id, { [ulid()]: "Wrong card" }))
			.toThrow(/Card questions do not match/);
		expect(room.project(document)).toBe(before);
	});

	it("refuses duplicate question IDs inside one answer target", async () => {
		let document = await room.create();
		let card = questionnaire(ulid(), ulid(), ulid(), "First");
		let question = card.questions[0]!;
		room.insertQuestionnaire(document, {
			...card,
			questions: [question, {
				...question,
				header: "Second",
				options: [{ ...question.options[0]!, id: ulid() }],
			}],
		});
		let before = room.project(document);
		expect(() => room.projectAnswer(document, card.id, { [question.id]: "Once" }))
			.toThrow(/Card questions do not match/);
		expect(room.project(document)).toBe(before);
	});
});
