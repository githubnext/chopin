import { describe, expect, it } from "bun:test";
import { ulid } from "@chopin/dialect";
import * as room from "./room";
import { questionnaire } from "./card-projections.test-fixtures";

describe("questionnaire prompt projection", () => {
	it("rewrites only the matching card question", async () => {
		let document = await room.create();
		let first = questionnaire(ulid(), ulid(), ulid(), "First");
		let second = questionnaire(ulid(), ulid(), ulid(), "Second");
		room.insertQuestionnaires(document, [{ value: first }, { value: second }]);
		expect(room.hasQuestionnaire(document, first.id, first.questions[0]!.id)).toBe(true);
		expect(room.hasQuestionnaire(document, first.id, second.questions[0]!.id)).toBe(false);
		let mutation = room.projectPrompt(
			document,
			first.id,
			first.questions[0]!.id,
			"Which feature should ship first?",
		);
		expect(mutation?.source).toContain('prompt="Which feature should ship first?"');
		expect(mutation?.source).toContain('prompt="What should Second be?"');
		expect(mutation?.source.match(/prompt="Which feature should ship first\?"/g)).toHaveLength(1);
	});

	it("fails closed on a missing card or mismatched question", async () => {
		let document = await room.create();
		let card = questionnaire(ulid(), ulid(), ulid(), "First");
		room.insertQuestionnaire(document, card);
		let before = room.project(document);
		expect(room.hasQuestionnaire(document, ulid(), card.questions[0]!.id)).toBe(false);
		expect(() => room.projectPrompt(document, ulid(), card.questions[0]!.id, "Why?")).toThrow(
			/available/i,
		);
		expect(() => room.projectPrompt(document, card.id, ulid(), "Why?")).toThrow(/match/i);
		expect(room.project(document)).toBe(before);
	});
});
