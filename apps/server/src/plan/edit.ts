/**
 * Agent edits to the plan, addressed by block.
 *
 * An agent cannot hold a cursor, so it edits the way it reads: by position in
 * the list of top-level blocks. Positions move under concurrent editing, so a
 * batch names the revision it was written against and is refused outright if
 * the plan has moved on — a partly-applied batch would be worse than none.
 *
 * Operations run against the parsed document rather than the live tree, so
 * reading and editing share one index space and the whole batch either
 * serialises or fails before anything is written. Only once it has proven
 * itself is it reconciled into the live document, where untouched blocks keep
 * their identity and nobody loses a cursor to somebody else's edit.
 */

import { createHash } from "node:crypto";

import { lookup } from "@chopin/dialect/dialect";
import { parse } from "@chopin/dialect/parse";
import { serialize } from "@chopin/dialect/serialize";
import { ulid } from "@chopin/dialect/ulid";
import { assert } from "@chopin/dialect/validate";

import * as room from "./room";

import type { Root, RootContent } from "mdast";
import type { Plan } from "./service";

/** Enough leading text to tell two blocks apart without resending the source. */
const PREVIEW = 120;

/** How many past outlines to keep, so a stale batch can be told what moved. */
const HISTORY = 8;

export type Block = {
	index: number;
	type: string;
	preview: string;
	/** Content fingerprint. A collision only costs a needless rejection. */
	digest: string;
};

export type Operation =
	| { op: "insert"; index: number; source: string }
	| { op: "insert_root"; source: string }
	| { op: "replace"; index: number; source: string }
	| { op: "replace_root"; source: string }
	| { op: "move"; index: number; to: number }
	| { op: "delete"; index: number }
	| { op: "detach_question"; id: string };

export type Result =
	| {
		ok: true;
		revision: number;
		blocks: Block[];
		/** Questionnaires this batch took out of the plan. */
		detached: string[];
		/** The change to relay, absent when the batch was a no-op. */
		mutation: room.Mutation | undefined;
	}
	| { ok: false; reason: "stale"; revision: number; changed: number[]; blocks: Block[] }
	| { ok: false; reason: "invalid"; message: string };

/** The plan as the agent sees it. */
export function source(plan: Plan): string {
	return room.project(plan.document);
}

/** Describe the top-level blocks an agent can address. */
export function outline(plan: Plan, value = source(plan)): Block[] {
	let blocks = parse(value).children.map((node, index) => describe(node, index));
	remember(plan, plan.revision, blocks);
	return blocks;
}

/**
 * Apply a batch of operations, all or nothing.
 *
 * Every operation is resolved against the document as it was read, so indices
 * within one batch do not shift under each other; the result is serialised and
 * re-parsed before it replaces anything, so a batch that would produce a
 * document outside the dialect fails without touching the plan.
 */
export function apply(plan: Plan, revision: number, operations: Operation[]): Result {
	if (revision !== plan.revision) {
		let blocks = outline(plan);
		return {
			ok: false,
			reason: "stale",
			revision: plan.revision,
			changed: drift(plan, revision, blocks),
			blocks,
		};
	}
	if (operations.length === 0) return { ok: false, reason: "invalid", message: "No operations." };
	if (operations.length > 1 && operations.some(operation => operation.op === "replace_root")) {
		return {
			ok: false,
			reason: "invalid",
			message: "replace_root must be the only operation in its batch.",
		};
	}
	let targets = new Set<number>();
	for (let operation of operations) {
		if (!("index" in operation)) continue;
		if (targets.has(operation.index)) {
			return {
				ok: false,
				reason: "invalid",
				message: `Block ${operation.index} is targeted more than once in one batch.`,
			};
		}
		targets.add(operation.index);
	}

	let root: Root;
	try {
		root = parse(source(plan));
	} catch (err) {
		return { ok: false, reason: "invalid", message: reason(err) };
	}

	let children = [...root.children];
	let detach: string[] = [];

	for (let [position, operation] of operations.entries()) {
		let outcome = step(root.children, children, operation, detach);
		if (typeof outcome === "string") {
			return { ok: false, reason: "invalid", message: `Operation ${position + 1}: ${outcome}` };
		}
		children = outcome;
	}
	if (children.length === 0) {
		return { ok: false, reason: "invalid", message: "The planner cannot clear the plan." };
	}

	let duplicate = repeated(children);
	if (duplicate) {
		return {
			ok: false,
			reason: "invalid",
			message: `\`${duplicate}\` appears twice; copied source keeps the original's id, `
				+ "so insert new content rather than duplicating a block you read.",
		};
	}

	let next: string;
	try {
		next = serialize({ ...root, children });
		// Parsing only proves the result is MDX. `<script>` is perfectly good
		// MDX and utterly outside this dialect, so validate what we are about
		// to write — a rejected batch is recoverable, a poisoned room is not.
		let parsed = parse(next);
		assert(parsed, { bytes: new TextEncoder().encode(next).byteLength });
		if (parsed.children.length !== children.length) {
			throw new Error("plan blocks merge or split during Markdown normalisation");
		}
		room.validate(next);
	} catch (err) {
		return { ok: false, reason: "invalid", message: reason(err) };
	}

	// Proven; now reconcile it into the live document rather than replacing
	// one. Untouched blocks keep their Lexical identity, so nobody editing
	// alongside the agent loses a cursor or an undo step to this.
	let mutation: room.Mutation | undefined;
	try {
		mutation = room.reconcile(plan.document, root.children, children);
	} catch (err) {
		return { ok: false, reason: "invalid", message: reason(err) };
	}

	return {
		ok: true,
		detached: detach,
		mutation,
		revision: plan.revision,
		blocks: outline(plan),
	};
}

/** Apply one operation, or describe why it cannot be applied. */
function step(
	base: RootContent[],
	children: RootContent[],
	operation: Operation,
	detach: string[],
): RootContent[] | string {
	switch (operation.op) {
		case "replace_root": {
			let parsed = fragment(operation.source);
			return typeof parsed === "string" ? parsed : parsed;
		}
		case "insert_root": {
			let parsed = fragment(operation.source);
			if (typeof parsed === "string") return parsed;
			return [...children, ...parsed];
		}
		case "insert": {
			let target = addressed(base, operation.index);
			if (typeof target === "string") return target;
			let index = children.indexOf(target);
			if (index < 0) return changed(operation.index);
			let parsed = fragment(operation.source);
			if (typeof parsed === "string") return parsed;
			return [
				...children.slice(0, index + 1),
				...parsed,
				...children.slice(index + 1),
			];
		}
		case "replace": {
			let target = addressed(base, operation.index);
			if (typeof target === "string") return target;
			if (decision(target)) return protects(operation.index);
			let index = children.indexOf(target);
			if (index < 0) return changed(operation.index);
			let parsed = fragment(operation.source);
			if (typeof parsed === "string") return parsed;
			return [
				...children.slice(0, index),
				...parsed,
				...children.slice(index + 1),
			];
		}
		case "delete": {
			let target = addressed(base, operation.index);
			if (typeof target === "string") return target;
			if (decision(target)) return protects(operation.index);
			let index = children.indexOf(target);
			if (index < 0) return changed(operation.index);
			return children.filter((_, position) => position !== index);
		}
		case "move": {
			let target = addressed(base, operation.index);
			if (typeof target === "string") return target;
			let destination = addressed(base, operation.to);
			if (typeof destination === "string") return destination;
			let index = children.indexOf(target);
			let to = children.indexOf(destination);
			if (index < 0) return changed(operation.index);
			if (to < 0) return changed(operation.to);
			if (target === destination) return children;

			let rest = children.filter(node => node !== target);
			let position = rest.indexOf(destination);
			if (operation.to > operation.index) position++;
			rest.splice(position, 0, target);
			return rest;
		}
		case "detach_question": {
			let index = children.findIndex(node => questionnaire(node) === operation.id);
			if (index < 0) return `no questionnaire ${operation.id} in the plan.`;
			detach.push(operation.id);
			return children.filter((_, position) => position !== index);
		}
	}
}

/**
 * The first id used by two components.
 *
 * An agent that copies a block it read copies the id with it, and durable
 * state hangs off that id — two nodes claiming one is worse than a rejection.
 */
function repeated(children: RootContent[]): string | undefined {
	let seen = new Set<string>();
	let found: string | undefined;

	let walk = (node: RootContent) => {
		if (found) return;
		if (node.type === "mdxJsxFlowElement" || node.type === "mdxJsxTextElement") {
			for (let attribute of node.attributes) {
				if (attribute.type !== "mdxJsxAttribute" || attribute.name !== "id") continue;
				if (typeof attribute.value !== "string") continue;
				if (seen.has(attribute.value)) found = attribute.value;
				else seen.add(attribute.value);
			}
		}
		if ("children" in node && Array.isArray(node.children)) {
			for (let child of node.children) walk(child as RootContent);
		}
	};

	for (let child of children) walk(child);
	return found;
}

/**
 * Components the agent may not author.
 *
 * Each is a projection of something a record owns — a questionnaire's answer, a
 * thread the room accepted — so writing one by hand would create a second
 * account of a decision that is already settled somewhere else.
 */
const RESERVED_COMPONENTS = new Set([
	"Questionnaire",
	"Question",
	"Option",
	"Answer",
	"Decision",
	"Note",
]);

/** Parse an operation's source as a run of top-level blocks. */
function fragment(value: string): RootContent[] | string {
	try {
		let root = parse(value);
		if (root.children.length === 0) return "source produced no blocks.";

		let refused = identify(root);
		if (refused) return refused;

		// Validate the fragment too, so the failure names the operation that
		// caused it rather than surfacing against the assembled document.
		assert(root);
		return root.children;
	} catch (err) {
		return reason(err);
	}
}

/**
 * Give the agent's components their identity.
 *
 * An id is required but not the agent's to choose: durable state hangs off it,
 * and a model that copies a block it read would copy the id with it. The agent
 * writes `<Callout type="note">` and identity is added here, exactly as the
 * editor's own insert command mints one.
 */
function identify(root: Root): string | undefined {
	let refused: string | undefined;

	let walk = (node: RootContent) => {
		if (refused) return;
		if (node.type === "mdxJsxFlowElement" || node.type === "mdxJsxTextElement") {
			let spec = lookup(node.name);
			if (spec) {
				if (RESERVED_COMPONENTS.has(spec.name)) {
					refused = spec.name === "Decision" || spec.name === "Note"
						? `\`${spec.name}\` is written when the room accepts a comment, not by editing the plan.`
						: `\`${spec.name}\` is created by asking a question, not by editing the plan.`;
					return;
				}
				stamp(node, spec);
			}
		}
		if ("children" in node && Array.isArray(node.children)) {
			for (let child of node.children) walk(child as RootContent);
		}
	};

	for (let child of root.children) walk(child);
	return refused;
}

/** Add an `id` where the component needs one and has none. */
function stamp(
	node: Extract<RootContent, { type: "mdxJsxFlowElement" | "mdxJsxTextElement" }>,
	spec: NonNullable<ReturnType<typeof lookup>>,
): void {
	let named = new Set(
		node.attributes
			.filter(attribute => attribute.type === "mdxJsxAttribute")
			.map(attribute => attribute.name),
	);

	if (spec.attributes.id && !named.has("id")) {
		node.attributes.push({ type: "mdxJsxAttribute", name: "id", value: ulid() });
	}
}

function addressed(children: RootContent[], index: number): RootContent | string {
	if (!Number.isSafeInteger(index) || index < 0 || index >= children.length) {
		return missing(index, children);
	}
	return children[index]!;
}

function missing(index: number, children: RootContent[]): string {
	return `no block at index ${index}; the plan has ${children.length}.`;
}

function changed(index: number): string {
	return `block ${index} is already changed by another operation in this batch.`;
}

function protects(index: number): string {
	return `block ${index} is a decision the room accepted; it cannot be edited or removed.`;
}

/** The questionnaire id a node carries, when it is one. */
function questionnaire(node: RootContent): string | undefined {
	if (node.type !== "mdxJsxFlowElement" || node.name !== "Questionnaire") return undefined;
	for (let attribute of node.attributes) {
		if (attribute.type !== "mdxJsxAttribute" || attribute.name !== "id") continue;
		if (typeof attribute.value === "string") return attribute.value;
	}
	return undefined;
}

/**
 * Whether a block is an accepted decision.
 *
 * `detach_question` exists because taking a questionnaire out of the plan had
 * to be a deliberate, recorded act rather than a side effect of tidying. A
 * decision is less removable than a question, not more: it is what the room
 * settled, and the record it projects has no way to hear that it is gone.
 */
function decision(node: RootContent): boolean {
	return node.type === "mdxJsxFlowElement" && node.name === "Decision";
}

function describe(node: RootContent, index: number): Block {
	let text = content(node);
	return {
		index,
		type: node.type === "mdxJsxFlowElement" ? node.name || "component" : node.type,
		preview: text.length > PREVIEW ? text.slice(0, PREVIEW) + "…" : text,
		digest: fingerprint(node),
	};
}

/** Flatten a node to its text, for previews and fingerprints. */
function content(node: RootContent): string {
	if ("value" in node && typeof node.value === "string") return node.value;
	if ("children" in node && Array.isArray(node.children)) {
		return node.children.map(child => content(child as RootContent)).join(" ");
	}
	return "";
}

function fingerprint(node: RootContent): string {
	let source = serialize({ type: "root", children: [node] });
	return `sha256:${createHash("sha256").update(source).digest("hex")}`;
}

function remember(plan: Plan, revision: number, blocks: Block[]): void {
	plan.outlines.set(revision, blocks);
	while (plan.outlines.size > HISTORY) {
		let oldest = plan.outlines.keys().next().value;
		if (oldest === undefined) break;
		plan.outlines.delete(oldest);
	}
}

/** Which blocks differ from the revision the agent last read. */
function drift(plan: Plan, revision: number, blocks: Block[]): number[] {
	let previous = plan.outlines.get(revision);
	if (!previous) return blocks.map(block => block.index);

	let changed: number[] = [];
	let length = Math.max(previous.length, blocks.length);
	for (let index = 0; index < length; index++) {
		if (previous[index]?.digest !== blocks[index]?.digest) changed.push(index);
	}
	return changed;
}

function reason(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
