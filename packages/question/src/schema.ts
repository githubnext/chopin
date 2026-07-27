/**
 * Questionnaire definitions.
 *
 * A definition comes from an agent tool call, so it is untrusted input: this
 * module is what turns it into something the rest of the system can rely on.
 * Definitions are frozen once accepted — an answer only means anything against
 * the exact question that was asked.
 */

import * as limits from "./limits";

import type { Question } from "@chopin/protocol";

export type Option = Question.Option;
export type Item = Question.Item;
export type Definition = Question.Definition;
export type Answer = Question.Answer;

/** Thrown for any malformed definition; the message reaches the agent. */
export class QuestionError extends Error {
	override readonly name = "QuestionError";
}

function fail(message: string): never {
	throw new QuestionError(message);
}

function record(value: unknown, name: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		fail(`${name} must be an object`);
	}
	return value as Record<string, unknown>;
}

/** Reject unknown fields outright rather than ignoring them silently. */
function exact(value: Record<string, unknown>, keys: string[], name: string): void {
	let actual = Object.keys(value).sort();
	let expected = keys.toSorted();
	if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
		fail(`${name} has invalid fields`);
	}
}

function text(value: unknown, name: string, max: number, optional = false): string {
	if (typeof value !== "string") fail(`${name} must be text`);
	let result = value.trim();
	if (!optional && !result) fail(`${name} is required`);
	if (result.length > max) fail(`${name} exceeds ${max} characters`);
	return result;
}

/**
 * Validate an agent's tool input into a frozen definition.
 *
 * Option and question identifiers are positional because they only have to be
 * unique within one call. Durable plan questionnaires re-key them to ULIDs on
 * the way in, since those do have to survive rewrites.
 *
 * @throws {QuestionError}
 */
export function normalize(raw: unknown): Definition {
	let args = record(raw, "Question tool input");
	exact(args, ["questions"], "Question tool input");

	if (!Array.isArray(args.questions) || args.questions.length === 0) {
		fail("At least one question is required");
	}
	if (args.questions.length > limits.MAX_QUESTIONS) {
		fail(`A questionnaire can contain at most ${limits.MAX_QUESTIONS} questions`);
	}

	let questions: Item[] = args.questions.map((source, index) => {
		let raw = record(source, `Question ${index + 1}`);
		exact(raw, ["header", "question", "options", "multiple"], `Question ${index + 1}`);

		if (!Array.isArray(raw.options) || raw.options.length === 0) {
			fail(`Question ${index + 1} requires at least one option`);
		}
		if (raw.options.length > limits.MAX_OPTIONS) {
			fail(`Question ${index + 1} can contain at most ${limits.MAX_OPTIONS} options`);
		}
		if (typeof raw.multiple !== "boolean") {
			fail(`Question ${index + 1} multiple must be a boolean`);
		}

		let options: Option[] = raw.options.map((source, position) => {
			let option = record(source, `Question ${index + 1} option ${position + 1}`);
			exact(option, ["label", "description"], `Question ${index + 1} option ${position + 1}`);
			return {
				id: `o${position}`,
				label: text(
					option.label,
					`Question ${index + 1} option ${position + 1} label`,
					limits.MAX_LABEL,
				),
				description: text(
					option.description,
					`Question ${index + 1} option ${position + 1} description`,
					limits.MAX_DESCRIPTION,
					true,
				),
			};
		});

		for (let option of options) Object.freeze(option);
		Object.freeze(options);

		return {
			id: `q${index}`,
			header: text(raw.header, `Question ${index + 1} header`, limits.MAX_HEADER),
			question: text(raw.question, `Question ${index + 1}`, limits.MAX_QUESTION),
			options,
			multiple: raw.multiple,
		};
	});

	for (let question of questions) Object.freeze(question);
	Object.freeze(questions);

	return Object.freeze({ questions });
}

/** Reject a tool call id that could not have come from the SDK. */
export function assertCallId(id: string): void {
	if (!id || id.length > limits.MAX_CALL_ID) fail("Question tool call ID is invalid");
}

export { fail as reject };
