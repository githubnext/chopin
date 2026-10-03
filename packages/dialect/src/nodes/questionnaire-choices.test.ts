import { expect, it } from "bun:test";

import * as limits from "../limits";
import { ulid } from "../ulid";

import { BLUE, CANARY, ID, OPEN, QUESTION, through } from "./questionnaire.test-fixtures";

// Whole archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2 callbacks.
it("round-trips chosen option identifiers", () => {
	let source = OPEN.replace(
		"</Question>",
		`<Answer value="Blue-green" choices="${BLUE}" />\n</Question>`,
	);
	let out = through(source);
	expect(through(out)).toBe(out);
	expect(out).toContain(`<Answer value="Blue-green" choices="${BLUE}"`);
});

it("round-trips multiple chosen option identifiers", () => {
	let source = OPEN.replace('multiple="false"', 'multiple="true"').replace(
		"</Question>",
		`<Answer value="Canary, Blue-green" choices="${CANARY} ${BLUE}" />\n</Question>`,
	);
	let out = through(source);
	expect(through(out)).toBe(out);
	expect(out).toContain(`choices="${CANARY} ${BLUE}"`);
});

it("keeps older and custom answers without chosen identifiers", () => {
	let source = OPEN.replace(
		"</Question>",
		`<Answer value="Only anchors" />\n</Question>`,
	);
	let out = through(source);
	expect(through(out)).toBe(out);
	expect(out).toContain('<Answer value="Only anchors"');
	expect(out).not.toContain("choices=");
});

it("rejects unknown, duplicate, and excess chosen identifiers", () => {
	let answer = (choices: string) =>
		OPEN.replace("</Question>", `<Answer value="Canary" choices="${choices}" />\n</Question>`);
	expect(() => through(answer(ID))).toThrow(/Answer choices must name options/);
	expect(() => through(answer(`${CANARY} ${CANARY}`))).toThrow(/cannot repeat/);
	expect(() => through(answer(`${CANARY} ${BLUE}`))).toThrow(/accepts one choice/);
});

it("rejects more chosen identifiers than the legacy option ceiling", () => {
	let ids = Array.from({ length: limits.MAX_OPTIONS + 1 }, () => ulid());
	let source = (selected: string[]) =>
		`<Questionnaire id="${ID}">\n`
		+ `<Question id="${QUESTION}" header="Rollout" prompt="How?" multiple="true">\n`
		+ ids.map(id => `<Option id="${id}" label="Choice" />\n`).join("")
		+ `<Answer value="Choices" choices="${selected.join(" ")}" />\n`
		+ `</Question>\n</Questionnaire>\n`;
	expect(through(source(ids.slice(0, limits.MAX_OPTIONS)))).toContain("<Answer value=");
	expect(() => through(source(ids))).toThrow(/at most 20 choices/);
});
