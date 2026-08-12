/**
 * Validating an agent's tool call arguments before they reach the plan.
 *
 * `edit_plan` and `anchor_plan` receive `raw: unknown`, and the `as` casts
 * that used to stand in for checking it are erased at runtime: `operations`
 * sent as a JSON-encoded string surfaced only as `operations.some is not a
 * function`. Every check here mirrors a line of the JSON schema in `tools.ts`
 * so the two cannot quietly disagree, and each failure names the field and
 * the shape it needed so the model can retry.
 */

import * as Question from "@chopin/question";

import type { Operation } from "../plan/edit";

/** Thrown for any malformed tool call; the message reaches the model. */
export class ArgumentError extends Error {
	override readonly name = "ArgumentError";
}

function fail(message: string): never {
	throw new ArgumentError(message);
}

function record(value: unknown, name: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		fail(`\`${name}\` must be an object.`);
	}
	return value as Record<string, unknown>;
}

/** No unknown fields, and every field in `required` present. */
function fields(
	value: Record<string, unknown>,
	allowed: string[],
	required: string[],
	name: string,
): void {
	let extra = Object.keys(value).filter(key => !allowed.includes(key));
	if (extra.length > 0) {
		fail(`\`${name}\` has unexpected field${extra.length > 1 ? "s" : ""}: ${extra.join(", ")}.`);
	}
	let missing = required.filter(key => !(key in value));
	if (missing.length > 0) {
		fail(
			`\`${name}\` is missing ${missing.length > 1 ? "fields" : "field"}: ${missing.join(", ")}.`,
		);
	}
}

/** A JSON string and an array-like object both fail here, uncoerced on purpose. */
function array(value: unknown, name: string, of: string, min?: number, max?: number): unknown[] {
	if (!Array.isArray(value)) fail(`\`${name}\` must be an array of ${of} objects.`);
	if (min !== undefined && value.length < min) {
		fail(`\`${name}\` requires at least ${min} ${of}${min === 1 ? "" : "s"}.`);
	}
	if (max !== undefined && value.length > max) {
		fail(`\`${name}\` allows at most ${max} ${of}${max === 1 ? "" : "s"}.`);
	}
	return value;
}

function integer(value: unknown, name: string): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
		fail(`\`${name}\` must be a non-negative integer.`);
	}
	return value;
}

function text(value: unknown, name: string, max?: number): string {
	if (typeof value !== "string") fail(`\`${name}\` must be text.`);
	if (max !== undefined && value.length > max) fail(`\`${name}\` exceeds ${max} characters.`);
	return value;
}

/** The limits `tools.ts` advertises in its schemas. */
const MAX_SOURCE = 100_000;
const MAX_OPERATIONS = 50;
const MAX_ANCHORS = 100;
const MAX_QUESTIONS = 10;

const OPS = [
	"insert",
	"insert_root",
	"replace",
	"replace_root",
	"move",
	"delete",
	"detach_question",
] as const;

type Op = typeof OPS[number];

const OPERATION_FIELDS = ["op", "index", "to", "source", "id"];

function kind(value: unknown, name: string): Op {
	if (typeof value !== "string" || !(OPS as readonly string[]).includes(value)) {
		fail(`\`${name}\` must be one of ${OPS.join(", ")}.`);
	}
	return value as Op;
}

/**
 * One operation. Which fields it needs depends on its `op`, which one shared
 * object shape cannot express in the schema, so the conditional lives here.
 */
function operation(raw: unknown, position: number): Operation {
	let name = `operations[${position}]`;
	let value = record(raw, name);
	fields(value, OPERATION_FIELDS, ["op"], name);

	let op = kind(value.op, `${name}.op`);

	let index = "index" in value ? integer(value.index, `${name}.index`) : undefined;
	let to = "to" in value ? integer(value.to, `${name}.to`) : undefined;
	let source = "source" in value ? text(value.source, `${name}.source`, MAX_SOURCE) : undefined;
	let id = "id" in value ? text(value.id, `${name}.id`) : undefined;

	switch (op) {
		case "insert":
			if (index === undefined) fail(`\`${name}.index\` is required for "insert".`);
			if (source === undefined) fail(`\`${name}.source\` is required for "insert".`);
			return { op, index, source };
		case "insert_root":
			if (source === undefined) fail(`\`${name}.source\` is required for "insert_root".`);
			return { op, source };
		case "replace":
			if (index === undefined) fail(`\`${name}.index\` is required for "replace".`);
			if (source === undefined) fail(`\`${name}.source\` is required for "replace".`);
			return { op, index, source };
		case "replace_root":
			if (source === undefined) fail(`\`${name}.source\` is required for "replace_root".`);
			return { op, source };
		case "move":
			if (index === undefined) fail(`\`${name}.index\` is required for "move".`);
			if (to === undefined) fail(`\`${name}.to\` is required for "move".`);
			return { op, index, to };
		case "delete":
			if (index === undefined) fail(`\`${name}.index\` is required for "delete".`);
			return { op, index };
		case "detach_question":
			if (id === undefined) fail(`\`${name}.id\` is required for "detach_question".`);
			return { op, id };
	}
}

/** Validate `edit_plan`'s tool input into the shape `edit.apply` expects. */
export function editPlan(raw: unknown): { revision: number; operations: Operation[] } {
	let args = record(raw, "edit_plan arguments");
	fields(args, ["revision", "operations"], ["revision", "operations"], "edit_plan arguments");

	let revision = integer(args.revision, "revision");
	let operations = array(args.operations, "operations", "operation", 1, MAX_OPERATIONS)
		.map((item, index) => operation(item, index));

	return { revision, operations };
}

const DIGEST = /^sha256:[0-9a-f]{64}$/;

function anchorDigest(value: unknown, name: string): string {
	if (typeof value !== "string" || !DIGEST.test(value)) {
		fail(`\`${name}\` must be a digest of the form "sha256:<64 hex characters>".`);
	}
	return value;
}

function block(raw: unknown, name: string): { index: number; digest: string } {
	let value = record(raw, name);
	fields(value, ["index", "digest"], ["index", "digest"], name);
	return {
		index: integer(value.index, `${name}.index`),
		digest: anchorDigest(value.digest, `${name}.digest`),
	};
}

const ANCHOR_FIELDS = ["widget", "question", "thread", "blocks"];

type Anchor = {
	widget?: string;
	question?: string;
	thread?: string;
	blocks: Array<{ index: number; digest: string }>;
};

/** One anchor. Only `blocks` is required; the handler decides the rest. */
function anchor(raw: unknown, position: number): Anchor {
	let name = `anchors[${position}]`;
	let value = record(raw, name);
	fields(value, ANCHOR_FIELDS, ["blocks"], name);

	// No minimum: an empty list is reviewed-and-unrelated, a real answer.
	let blocks = array(value.blocks, `${name}.blocks`, "block")
		.map((item, index) => block(item, `${name}.blocks[${index}]`));

	let result: Anchor = { blocks };
	if ("widget" in value) result.widget = text(value.widget, `${name}.widget`);
	if ("question" in value) result.question = text(value.question, `${name}.question`);
	if ("thread" in value) result.thread = text(value.thread, `${name}.thread`);
	return result;
}

/** Validate `anchor_plan`'s tool input into the shape its handler expects. */
export function anchorPlan(raw: unknown): { revision: number; anchors: Anchor[] } {
	let args = record(raw, "anchor_plan arguments");
	fields(args, ["revision", "anchors"], ["revision", "anchors"], "anchor_plan arguments");

	let revision = integer(args.revision, "revision");
	let anchors = array(args.anchors, "anchors", "anchor", 1, MAX_ANCHORS)
		.map((item, index) => anchor(item, index));

	return { revision, anchors };
}

export type BlockAddress = { index: number; digest: string };

export type PositionedQuestion = {
	header: string;
	question: string;
	options: Array<{ label: string; description: string }>;
	multiple: boolean;
	blocks: BlockAddress[];
};

/**
 * Validate `ask`'s question definitions and the prose each one relates to.
 *
 * The question package owns the detailed normalisation rules; keeping
 * placement here means its extra field cannot leak into that strict contract.
 */
export function askPlan(raw: unknown): { revision: number; questions: PositionedQuestion[] } {
	let args = record(raw, "ask arguments");
	fields(args, ["revision", "questions"], ["revision", "questions"], "ask arguments");

	let revision = integer(args.revision, "revision");
	let questions = array(args.questions, "questions", "question", 1, MAX_QUESTIONS)
		.map((raw, index) => {
			let name = `questions[${index}]`;
			let question = record(raw, name);
			fields(question, ["header", "question", "options", "multiple", "blocks"], [
				"header",
				"question",
				"options",
				"multiple",
				"blocks",
			], name);

			let blocks = array(question.blocks, `${name}.blocks`, "block")
				.map((item, blockIndex) => block(item, `${name}.blocks[${blockIndex}]`));
			let normalized = Question.normalize({
				questions: [{
					header: question.header,
					question: question.question,
					options: question.options,
					multiple: question.multiple,
				}],
			}).questions[0]!;

			return {
				header: normalized.header,
				question: normalized.question,
				options: normalized.options.map(option => ({
					label: option.label,
					description: option.description,
				})),
				multiple: normalized.multiple,
				blocks,
			};
		});

	return { revision, questions };
}
