/**
 * The shared answer draft.
 *
 * Everyone editing a questionnaire works on one collaborative document rather
 * than private answers, because the result is a single decision. The VM holds
 * the authoritative model and validates every patch against the definition
 * before accepting it — a client cannot introduce a shape the definition does
 * not describe.
 */

import * as crdt from "json-joy/lib/json-crdt";

import * as limits from "./limits";
import { reject } from "./schema";

import type { NodeBuilder } from "json-joy/lib/json-crdt";
import type { Definition, Item } from "./schema";
import type { Question } from "@chopin/protocol";

export type Mode = "choices" | "custom";
export type Draft = Question.DraftAnswer;
export type Drafts = Record<string, Draft>;

export type Model = crdt.Model<crdt.ObjNode<Record<string, crdt.JsonNode<unknown>>>>;

/**
 * Build the initial draft for a definition.
 *
 * Answer state is a fixed shape derived from the questions, so a patch that
 * adds or removes keys is invalid by construction rather than by convention.
 */
export function create(definition: Definition): Model {
	let questions: Record<string, NodeBuilder> = {};

	for (let question of definition.questions) {
		let options: Record<string, NodeBuilder> = {};
		for (let option of question.options) {
			options[option.id] = crdt.schema.val(crdt.schema.con(false));
		}

		questions[question.id] = crdt.schema.obj({
			mode: crdt.schema.val(
				crdt.schema.con<Mode>(question.options.length ? "choices" : "custom"),
			),
			choice: crdt.schema.val(crdt.schema.con<string | null>(null)),
			options: crdt.schema.obj(options),
			// A CRDT string, so two people typing a custom answer merge rather
			// than overwrite.
			custom: crdt.schema.str(""),
		});
	}

	let model = crdt.Model.create(crdt.schema.obj(questions));
	model.api.flush();

	if (model.toBinary().byteLength > limits.MAX_MODEL_BYTES) {
		reject(
			`Questionnaire collaboration state exceeds the ${limits.MAX_MODEL_BYTES / 1024} KiB limit`,
		);
	}

	return model;
}

/** Restore a complete shared draft, proving it still matches its definition. */
export function restore(binary: number[], definition: Definition): Model {
	if (binary.length > limits.MAX_MODEL_BYTES) {
		reject(
			`Questionnaire collaboration state exceeds the ${limits.MAX_MODEL_BYTES / 1024} KiB limit`,
		);
	}
	let model = crdt.Model.fromBinary<crdt.ObjNode<Record<string, crdt.JsonNode<unknown>>>>(
		new Uint8Array(binary),
	);
	read(model, definition);
	return model;
}

function keys(node: crdt.ObjNode, expected: string[], name: string): void {
	let actual = [...node.keys.keys()].sort();
	let sorted = expected.toSorted();
	if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) {
		reject(`${name} has invalid keys`);
	}
}

function register(node: unknown, name: string): unknown {
	if (!(node instanceof crdt.ValNode)) reject(`${name} must be an LWW register`);
	return (node as crdt.ValNode).view();
}

/**
 * Read a model as drafts, rejecting anything that does not match the definition.
 *
 * This is the security boundary for collaborative edits: the VM applies a patch
 * to a clone and runs this before committing, so a malformed patch never
 * reaches the authoritative model.
 *
 * @throws {QuestionError}
 */
export function read(model: Model, definition: Definition): Drafts {
	let root = model.root.child();
	if (!(root instanceof crdt.ObjNode)) reject("Questionnaire root must be an object");

	keys(root, definition.questions.map(question => question.id), "Questionnaire root");

	let drafts: Drafts = {};

	for (let question of definition.questions) {
		let node = root.get(question.id);
		if (!(node instanceof crdt.ObjNode)) reject(`${question.id} must be an object`);
		keys(node, ["mode", "choice", "options", "custom"], question.id);

		let mode = register(node.get("mode"), `${question.id}.mode`);
		if (mode !== "choices" && mode !== "custom") reject(`${question.id}.mode is invalid`);

		let choice = register(node.get("choice"), `${question.id}.choice`);
		if (choice !== null && typeof choice !== "string") {
			reject(`${question.id}.choice must be an option ID or null`);
		}
		if (typeof choice === "string" && !question.options.some(option => option.id === choice)) {
			reject(`${question.id}.choice contains an invalid option ID`);
		}

		let optionNode = node.get("options");
		if (!(optionNode instanceof crdt.ObjNode)) reject(`${question.id}.options must be an object`);
		keys(optionNode, question.options.map(option => option.id), `${question.id}.options`);

		let options: Record<string, boolean> = {};
		for (let option of question.options) {
			let selected = register(optionNode.get(option.id), `${question.id}.options.${option.id}`);
			if (typeof selected !== "boolean") {
				reject(`${question.id}.options.${option.id} must be a boolean LWW register`);
			}
			options[option.id] = selected;
		}

		let custom = node.get("custom");
		if (!(custom instanceof crdt.StrNode)) reject(`${question.id}.custom must be a CRDT string`);
		let value = (custom as crdt.StrNode).view();
		if (value.length > limits.MAX_CUSTOM) {
			reject(`${question.id}.custom exceeds ${limits.MAX_CUSTOM} characters`);
		}

		drafts[question.id] = { mode: mode as Mode, choice, options, custom: value };
	}

	return drafts;
}

/** Whether a question has enough of an answer to submit. */
export function answered(question: Item, draft: Draft | undefined): boolean {
	if (!draft) return false;
	if (draft.mode === "custom") return !!draft.custom.trim();
	if (question.multiple) return question.options.some(option => draft.options[option.id]);
	return question.options.some(option => option.id === draft.choice);
}

/** Reject a patch that is malformed or too large before it is applied. */
export function assertPatch(binary: number[]): void {
	if (!Array.isArray(binary) || binary.length === 0) reject("Question edit patch is empty");
	if (binary.length > limits.MAX_PATCH_BYTES) {
		reject(`Question edit exceeds the ${limits.MAX_PATCH_BYTES / 1024} KiB patch limit`);
	}
	if (binary.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
		reject("Question edit patch contains invalid bytes");
	}
}

export type Applied =
	| { ok: true; model: Model; changed: boolean }
	| { ok: false; message: string };

/**
 * Apply one patch, if the result is still a draft the definition describes.
 *
 * The gate, and the reason a client cannot corrupt a shared answer: the patch
 * lands on a clone, the clone is read back against the definition, and only a
 * clone that survives that becomes the model. Anything else is a message.
 *
 * A patch that changes nothing reports `changed: false` rather than failing.
 * Peers have nothing to apply, and bumping a revision for it would invalidate
 * submissions that are in flight for no reason.
 */
export function apply(model: Model, definition: Definition, binary: number[]): Applied {
	try {
		assertPatch(binary);

		let before = model.toBinary();
		let next = model.clone();
		next.applyPatch(crdt.Patch.fromBinary(new Uint8Array(binary)));
		read(next, definition);

		let after = next.toBinary();
		if (after.byteLength > limits.MAX_MODEL_BYTES) {
			reject(`Answer exceeds the ${limits.MAX_MODEL_BYTES / 1024} KiB limit`);
		}

		let changed = after.length !== before.length
			|| after.some((byte, index) => byte !== before[index]);

		return { ok: true, model: changed ? next : model, changed };
	} catch (err) {
		return { ok: false, message: err instanceof Error ? err.message : String(err) };
	}
}

export { crdt };
