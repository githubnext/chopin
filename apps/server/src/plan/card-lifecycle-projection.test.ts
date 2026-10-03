import { describe, expect, it } from "bun:test";
import { ulid } from "@chopin/dialect";
import * as room from "./room";
import { questionnaire } from "./card-projections.test-fixtures";

describe("card lifecycle projection", () => {
	it("marks a card discarded without removing its answer or provenance", async () => {
		let document = await room.create();
		let card = questionnaire(ulid(), ulid(), ulid(), "Auth");
		let question = card.questions[0]!;
		room.insertQuestionnaire(document, card);
		room.projectAnswer(document, card.id, { [question.id]: "Choose this" }, {
			by: "ana",
			at: "2026-09-23T17:30:00.000Z",
		}, { [question.id]: [question.options[0]!.id] });

		let mutation = room.projectCard(document, card.id, { status: "discarded" });

		expect(mutation?.source).toContain('status="discarded"');
		expect(mutation?.source).toContain('by="ana"');
		expect(mutation?.source).toContain('<Answer value="Choose this"');
		expect(mutation?.source).toContain(`choices="${question.options[0]!.id}"`);
		expect(mutation?.source.match(/<Questionnaire/g)).toHaveLength(1);
		document.doc.destroy();
	});

	it("refuses missing and ambiguous card targets without changing source", async () => {
		let document = await room.create();
		let card = questionnaire(ulid(), ulid(), ulid(), "Auth");
		room.insertQuestionnaires(document, [
			{ value: card },
			{ value: questionnaire(card.id, ulid(), ulid(), "Other") },
		]);
		let before = room.project(document);

		expect(() => room.projectCard(document, ulid(), { status: "discarded" }))
			.toThrow(/Card is not available/);
		expect(() => room.projectCard(document, card.id, { status: "discarded" }))
			.toThrow(/Card is not available/);
		expect(room.project(document)).toBe(before);
		document.doc.destroy();
	});

	it("can clear an answer and show its previous choice when reopened", async () => {
		let document = await room.create();
		let card = questionnaire(ulid(), ulid(), ulid(), "Auth");
		let question = card.questions[0]!;
		let option = question.options[0]!.id;
		room.insertQuestionnaire(document, card);
		room.projectAnswer(document, card.id, { [question.id]: "Choose this" }, {
			by: "ana",
			at: "2026-09-23T17:30:00.000Z",
		}, { [question.id]: [option] });

		let mutation = room.projectCard(document, card.id, {
			status: "reopened",
			clearAnswers: true,
			previous: {
				[question.id]: { choices: [option], by: "ana", at: "2026-09-23T17:30:00.000Z" },
			},
		});

		expect(mutation?.source).toContain('status="reopened"');
		expect(mutation?.source).toContain(`<Previous choices="${option}" by="ana"`);
		expect(mutation?.source).not.toContain("<Answer");
		expect(mutation?.source).not.toContain('<Questionnaire id="' + card.id + '" by=');
		expect(() =>
			room.projectCard(document, card.id, {
				status: "reopened",
				previous: { missing: null },
			})
		).toThrow(/Card questions do not match/);
		let cleared = room.projectCard(document, card.id, {
			status: "open",
			previous: { [question.id]: null },
		});
		expect(cleared?.source).not.toContain("<Previous");
		document.doc.destroy();
	});
});
