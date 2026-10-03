import { describe, expect, it } from "bun:test";
import { ulid } from "@chopin/dialect";
import * as room from "./room";
import { questionnaire } from "./card-projections.test-fixtures";

describe("questionnaire option projection", () => {
	it("updates the matching card without changing its prompt or neighboring card", async () => {
		let document = await room.create();
		let first = questionnaire(ulid(), ulid(), ulid(), "First");
		let second = questionnaire(ulid(), ulid(), ulid(), "Second");
		let addedId = ulid();
		room.insertQuestionnaires(document, [{ value: first }, { value: second }]);
		let before = room.project(document);

		let mutation = room.projectOptions(document, first.id, {
			id: first.questions[0]!.id,
			header: "First",
			question: "What should First be?",
			multiple: false,
			options: [
				{ id: first.questions[0]!.options[0]!.id, label: "Choose this", description: "" },
				{ id: addedId, label: "GitHub Apps", description: "" },
			],
		});

		expect(mutation?.source).toContain('label="GitHub Apps"');
		expect(mutation?.source).toContain('prompt="What should First be?"');
		expect(mutation?.source.match(/label="GitHub Apps"/g)).toHaveLength(1);
		expect(room.project(document)).toContain(`id="${second.id}"`);
		expect(room.project(document)).toContain('prompt="What should Second be?"');
		expect(before).not.toContain("GitHub Apps");
	});

	it("refuses a missing card or mismatched question without changing the document", async () => {
		let document = await room.create();
		let card = questionnaire(ulid(), ulid(), ulid(), "First");
		room.insertQuestionnaire(document, card);
		let before = room.project(document);
		let question = {
			id: card.questions[0]!.id,
			header: "First",
			question: "What should First be?",
			multiple: false,
			options: [{ id: ulid(), label: "GitHub Apps", description: "" }],
		};

		expect(() => room.projectOptions(document, ulid(), question)).toThrow();
		expect(() => room.projectOptions(document, card.id, { ...question, id: ulid() })).toThrow();
		expect(room.project(document)).toBe(before);
	});
});
