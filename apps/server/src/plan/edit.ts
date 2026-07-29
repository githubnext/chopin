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

/** Enough of a block to recognise it in a list, without hashing it. */
export type Excerpt = { type: string; preview: string };

/**
 * Where a gap sits, in post-edit indices.
 *
 * A block that has gone cannot be addressed, so the space it left is named by
 * a block still beside it and the side the content was on.
 */
export type Spot = { index: number; side: "before" | "after" };

/**
 * One thing a batch did, as somewhere a reader can be pointed.
 *
 * A rewrite is `added` alone. Something is still there to look at, and a batch
 * that also reported a gap would put a tombstone on the most common edit the
 * agent makes.
 */
export type Change =
	| ({ kind: "added"; index: number } & Excerpt)
	| ({ kind: "moved"; index: number; from: Spot } & Excerpt)
	| { kind: "removed"; at: Spot; blocks: Excerpt[] };

export type Result =
	| {
		ok: true;
		revision: number;
		blocks: Block[];
		/**
		 * Indices of the blocks this batch authored.
		 *
		 * Told apart by object identity: a node carried over from the parsed
		 * base is the same object, a staged one is not. That is the property
		 * reconciliation already relies on, so it costs nothing to report.
		 */
		touched: number[];
		/** Questionnaires this batch took out of the plan. */
		detached: string[];
		/**
		 * What this batch did, in document order, for marking in the browser.
		 *
		 * Wider than `touched`, and not a superset of it: that answers which
		 * blocks now hold the agent's prose, which is what attributing a
		 * decision needs, and it is silent about a block that only moved or
		 * one that has gone. This answers where a reader should be sent, so a
		 * deletion is a place too and a rewrite is one change rather than a
		 * disappearance and an arrival.
		 *
		 * Indices rather than anchors: turning one into the other needs the
		 * live document, which is the service's to reach into, not this
		 * module's. Empty when there is nothing worth pointing at.
		 */
		changes: Change[];
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

	let carried = new Set(root.children);

	return {
		ok: true,
		detached: detach,
		mutation,
		revision: plan.revision,
		blocks: outline(plan),
		touched: children.flatMap((node, index) => carried.has(node) ? [] : [index]),
		changes: describeChanges(root.children, children, operations),
	};
}

/**
 * What a batch did, as places a reader can be sent.
 *
 * Two derivations, deliberately different. What was *written* comes from
 * object identity: a node reconciliation carried through is the same object,
 * and the agent cannot misreport that. What *moved or went* comes from the
 * operations, because identity cannot tell those apart — a node missing from
 * the result may have been deleted or replaced, and a node at a new index may
 * have moved or merely been pushed down by an insert above it.
 *
 * Both are exact here: a batch aborts on the first operation that fails, so
 * reaching this point means every one of them applied.
 */
function describeChanges(
	base: RootContent[],
	after: RootContent[],
	operations: Operation[],
): Change[] {
	// A batch that replaced the whole plan changed every block in it, and a
	// document marked from end to end says nothing at all. `replace_root` has
	// to stand alone, so this is the whole condition.
	if (operations.some(operation => operation.op === "replace_root")) return [];

	let carried = new Set(base);
	let place = new Map(after.map((node, index) => [node, index]));

	let left: { node: RootContent; index: number; moved: boolean }[] = [];
	for (let operation of operations) {
		switch (operation.op) {
			case "delete": {
				let node = base[operation.index];
				if (node) left.push({ node, index: operation.index, moved: false });
				break;
			}
			case "detach_question": {
				let index = base.findIndex(node => questionnaire(node) === operation.id);
				let node = base[index];
				if (node) left.push({ node, index, moved: false });
				break;
			}
			case "move": {
				// `step` treats this as a no-op, so neither end is worth marking.
				if (operation.to === operation.index) break;
				let node = base[operation.index];
				if (node) left.push({ node, index: operation.index, moved: true });
				break;
			}
		}
	}

	let vacating = new Set(left.map(item => item.node));
	let changes: Change[] = [];

	for (let [node, index] of place) {
		if (!carried.has(node)) changes.push({ kind: "added", index, ...excerpt(node) });
	}

	// Removals that left the same space collapse into one mark: three blocks
	// deleted in a row is one hole in the prose, not three.
	let holes = new Map<string, { at: Spot; blocks: Excerpt[] }>();

	for (let item of left) {
		let gap = gapAt(base, place, vacating, item.index);
		if (!gap) continue;

		if (item.moved) {
			let index = place.get(item.node);
			if (index === undefined) continue;
			changes.push({ kind: "moved", index, from: gap, ...excerpt(item.node) });
			continue;
		}

		let key = `${gap.index}:${gap.side}`;
		let hole = holes.get(key) ?? { at: gap, blocks: [] };
		hole.blocks.push(excerpt(item.node));
		holes.set(key, hole);
	}

	for (let hole of holes.values()) changes.push({ kind: "removed", ...hole });

	// Document order, so the list of changes reads the way the plan does.
	return changes.sort((a, b) => at(a) - at(b));
}

function at(change: Change): number {
	return change.kind === "removed" ? change.at.index : change.index;
}

/**
 * The gap a departed block left, named by a block still beside it.
 *
 * Scanned outwards from where it was, forward first, so a hole reads as
 * sitting above the block that followed it. Only blocks the batch inherited
 * are candidates — a block the batch wrote is not somewhere content used to
 * be — and a candidate must not itself have vacated: without that, deleting
 * one block and moving the next in the same batch would anchor the hole to a
 * block that has gone elsewhere, and point at the wrong prose.
 *
 * Nothing is returned when a batch vacated every block it inherited. The plan
 * cannot be emptied, so this only happens when everything moved, and a mark
 * omitted is cheaper than one that lies.
 */
function gapAt(
	base: RootContent[],
	place: Map<RootContent, number>,
	vacating: Set<RootContent>,
	index: number,
): Spot | undefined {
	for (let step = index + 1; step < base.length; step++) {
		let node = base[step]!;
		if (vacating.has(node)) continue;
		let found = place.get(node);
		if (found !== undefined) return { index: found, side: "before" };
	}
	for (let step = index - 1; step >= 0; step--) {
		let node = base[step]!;
		if (vacating.has(node)) continue;
		let found = place.get(node);
		if (found !== undefined) return { index: found, side: "after" };
	}
	return undefined;
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
	return { index, ...excerpt(node), digest: fingerprint(node) };
}

/**
 * Enough of a block to recognise it, without hashing it.
 *
 * Split from `describe` because what the agent removed has to be shown in a
 * list after the block itself is gone, and a fingerprint of something that no
 * longer exists is nothing anyone can use.
 */
function excerpt(node: RootContent): Excerpt {
	let text = content(node);
	return {
		type: node.type === "mdxJsxFlowElement" ? node.name || "component" : node.type,
		preview: text.length > PREVIEW ? text.slice(0, PREVIEW) + "…" : text,
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
