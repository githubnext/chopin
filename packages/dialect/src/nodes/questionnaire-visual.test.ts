import { expect, test } from "bun:test";
import { OPEN, through } from "./questionnaire.test-fixtures";

test("visual Questionnaire marker survives the real Lexical and MDX round trip", async () => {
	let source = OPEN.replace("<Questionnaire ", '<Questionnaire visual="decision-card-v1" ');
	expect(await through(source)).toContain('visual="decision-card-v1"');
});

test("unknown visual specimen cannot enter the dialect", async () => {
	let source = OPEN.replace("<Questionnaire ", '<Questionnaire visual="arbitrary-code" ');
	expect(() => through(source)).toThrow();
});
