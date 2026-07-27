/**
 * The authoritative collaborative document.
 *
 * The server owns the Y.Doc and a headless Lexical editor bound to it. That
 * mirror is what lets the server reason about the document at all: it turns
 * opaque CRDT updates into a tree that can be validated and projected back to
 * canonical MDX, with nobody connected.
 *
 * Clients never bootstrap. Two browsers opening an empty plan at the same time
 * would otherwise both seed it and duplicate the content, so the server creates
 * the initial state and everyone else syncs to it.
 */

import { createHash } from "node:crypto";

import { createHeadlessEditor } from "@lexical/headless";
import { createYjsBinding, syncLexicalUpdateToYjs, syncYjsChangesToLexical } from "@lexical/yjs";
import * as Y from "yjs";

import {
	$createPlanNodes,
	$createQuestionnaireNode,
	$exportPlan,
	$importPlan,
	exportPlan,
	limits,
	parse,
	PlanValidationError,
	QuestionnaireNode,
	registry as buildRegistry,
	serialize,
	ulid,
} from "@chopin/dialect";
import { $getRoot, $isParagraphNode, $nodesOfType } from "lexical";

import type { Binding, Provider } from "@lexical/yjs";
import type { LexicalEditor, LexicalNode } from "lexical";
import type { Root, RootContent } from "mdast";
import type { Questionnaire, Registry } from "@chopin/dialect";
import type { Plan } from "@chopin/protocol";

type Anchor = Plan.Anchor;

/** Awareness is relayed, never interpreted here, so a no-op provider suffices. */
const PROVIDER = {
	awareness: {
		getLocalState: () => null,
		getStates: () => new Map(),
		off() {},
		on() {},
		setLocalState() {},
		setLocalStateField() {},
	},
	connect() {},
	disconnect() {},
	off() {},
	on() {},
} as unknown as Provider;

const DOC = "plan";
const REMOTE = "remote";

/** Yjs state size past which history is compacted into a fresh epoch. */
const MAX_STATE = limits.MAX_COLLAB_BYTES;

export const LIMITS = {
	source: limits.MAX_SOURCE_BYTES,
	update: limits.MAX_UPDATE_BYTES,
	depth: limits.MAX_DEPTH,
};

export type Document = {
	/** Identifies one Yjs history. Updates carrying another are rejected. */
	epoch: string;
	doc: Y.Doc;
	editor: LexicalEditor;
	binding: Binding;
	/** Monotonic within an epoch. */
	seq: number;
	/**
	 * Last known-good Yjs state, and the source that matched it.
	 *
	 * Yjs cannot undo a transaction, so an update that turns out to be invalid
	 * cannot be rolled back — the document is rebuilt from here instead. This
	 * is refreshed when the room snapshots rather than on every commit: an
	 * invalid update means a bug somewhere, and paying to re-encode the whole
	 * document on the common path to soften a case that should never happen is
	 * the wrong trade.
	 */
	checkpoint: Uint8Array;
};

/**
 * The schema, built once per process.
 *
 * Registry construction walks every plugin, and the result is immutable and
 * shared. Rooms differ in their content, never in what content is legal.
 */
let registry: Registry | undefined;

function schema(): Registry {
	return registry ??= buildRegistry();
}

/** Remote updates reach Lexical on a microtask; let the mirror catch up. */
export async function settle(): Promise<void> {
	for (let i = 0; i < 3; i++) await new Promise(resolve => setTimeout(resolve, 0));
}

function build(epoch: string): Document {
	let reg = schema();
	let editor = createHeadlessEditor({
		nodes: reg.nodes,
		onError(err) {
			console.error("[plan] lexical:", err);
		},
	});

	let doc = new Y.Doc();
	let binding = createYjsBinding({ editor, id: DOC, doc, docMap: new Map([[DOC, doc]]) });

	editor.registerUpdateListener(
		({ dirtyElements, dirtyLeaves, editorState, normalizedNodes, prevEditorState, tags }) => {
			if (tags.has("skip-collab")) return;
			syncLexicalUpdateToYjs(
				binding,
				PROVIDER,
				prevEditorState,
				editorState,
				dirtyElements,
				dirtyLeaves,
				normalizedNodes,
				tags,
			);
		},
	);

	binding.root.getSharedType().observeDeep((events, transaction) => {
		if (transaction.origin !== binding) syncYjsChangesToLexical(binding, PROVIDER, events, false);
	});

	return { epoch, doc, editor, binding, seq: 0, checkpoint: Y.encodeStateAsUpdate(doc) };
}

/**
 * Seed from canonical MDX, through the mirror so Yjs sees real structure.
 *
 * Validation is on by default because the usual caller is a snapshot read back
 * from disk, which a person can edit between runs. Internally produced source —
 * a compaction, a replacement we just projected — has already been proven and
 * says so.
 */
function seed(target: Document, source: string, validated = false): void {
	if (!source.trim()) return;

	// Lexical routes anything thrown inside an update to the editor's onError,
	// which logs. Left alone, a plan that fails to import would produce an
	// empty document and no failure — so the error is carried out by hand.
	let failure: unknown;
	target.editor.update(
		() => {
			try {
				$importPlan(source, { registry: schema(), validate: !validated });
			} catch (err) {
				failure = err;
			}
		},
		{ discrete: true },
	);
	if (failure) throw failure;
}

/** Canonical MDX for the current shared state. Throws if it is not valid. */
export function project(target: Document): string {
	let source = "";
	let failure: unknown;
	target.editor.getEditorState().read(() => {
		try {
			source = $exportPlan({ registry: schema() });
		} catch (err) {
			failure = err;
		}
	});
	if (failure) throw failure;
	return source;
}

/**
 * Prove source survives the same Lexical import/export path as a live room.
 *
 * MDAST validation alone cannot catch a visitor that accepts a node but fails
 * to construct or export it. Anything about to be written to a real document
 * runs this scratch pass first.
 */
export function validate(source: string): void {
	let reg = schema();
	let editor = createHeadlessEditor({
		nodes: reg.nodes,
		onError(err) {
			throw err;
		},
	});

	let failure: unknown;
	editor.update(
		() => {
			try {
				$importPlan(source, { registry: reg });
			} catch (err) {
				failure = err;
			}
		},
		{ discrete: true },
	);
	if (failure) throw failure;

	// Export is part of the proof: we have to be able to snapshot what we
	// imported, not merely hold it in memory.
	let output = exportPlan(editor, { registry: reg });
	if (JSON.stringify(semantic(parse(output))) !== JSON.stringify(semantic(parse(source)))) {
		throw new Error("plan source changes during its Lexical round trip");
	}
}

/** MDAST equality without source positions or JSX attribute ordering. */
function semantic(value: unknown, key = ""): unknown {
	if (Array.isArray(value)) {
		let items = value.map(item => semantic(item));
		return key === "attributes"
			? items.toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
			: items;
	}
	if (!value || typeof value !== "object") return value;

	let out: Record<string, unknown> = {};
	for (let [name, child] of Object.entries(value)) {
		if (name === "position") continue;
		out[name] = semantic(child, name);
	}
	return out;
}

/** Create a document, optionally seeded from source that survived a restart. */
export async function create(source = "", validated = false): Promise<Document> {
	let created = build(ulid());
	seed(created, source, validated);
	await settle();
	created.checkpoint = Y.encodeStateAsUpdate(created.doc);
	return created;
}

/** State the given client is missing, or the whole document when it has none. */
export function sync(target: Document, vector?: Uint8Array): Uint8Array {
	return Y.encodeStateAsUpdate(target.doc, vector);
}

export function stateSize(target: Document): number {
	return Y.encodeStateAsUpdate(target.doc).byteLength;
}

export function needsCompaction(target: Document): boolean {
	return stateSize(target) >= MAX_STATE;
}

/** Record the current state as the one a rebuild should restore. */
export function mark(target: Document): void {
	target.checkpoint = Y.encodeStateAsUpdate(target.doc);
}

export type Applied =
	| { ok: true; seq: number }
	| { ok: false; issues: string[] };

/**
 * Apply a batch of client updates.
 *
 * Batched because validation is the expensive part: projecting the whole
 * document proves the shared tree still serialises to something the dialect
 * accepts, and doing that per keystroke would be absurd.
 */
export async function apply(target: Document, updates: Uint8Array[]): Promise<Applied> {
	if (updates.length === 0) return { ok: true, seq: target.seq };

	for (let update of updates) Y.applyUpdate(target.doc, update, REMOTE);
	await settle();

	try {
		project(target);
	} catch (err) {
		if (!(err instanceof PlanValidationError)) throw err;
		return { ok: false, issues: err.issues.map(issue => issue.code) };
	}

	target.seq += updates.length;
	return { ok: true, seq: target.seq };
}

/**
 * Restore the last known-good state under a new epoch.
 *
 * Everyone loses undo history and cursor positions, which is the price of the
 * document being coherent again.
 */
export async function rebuild(target: Document): Promise<Document> {
	let restored = build(ulid());
	Y.applyUpdate(restored.doc, target.checkpoint, REMOTE);
	await settle();
	restored.checkpoint = Y.encodeStateAsUpdate(restored.doc);
	return restored;
}

/**
 * Replace the content wholesale under a fresh epoch.
 *
 * For deliberate discontinuities only: clearing, and history compaction.
 * Ordinary agent edits reconcile into the live tree instead, so node identity,
 * selection and scroll position survive them.
 */
export async function replace(source: string): Promise<Document> {
	// Already projected from a live document, or validated by its caller.
	return create(source, true);
}

/**
 * Compact history once it outgrows its budget.
 *
 * Yjs keeps tombstones for everything ever deleted, so a long-lived document
 * grows well past the size of its content. Callers do this while the room is
 * idle, because it costs every client their undo history.
 */
export async function compact(target: Document): Promise<Document | undefined> {
	if (!needsCompaction(target)) return undefined;
	return replace(project(target));
}

// -- server-authored mutations ---------------------------------------------

export type Mutation = {
	/** Yjs delta covering only what this mutation changed. */
	update: Uint8Array;
	/** Canonical source afterwards. */
	source: string;
};

/**
 * Apply a change of our own to the live document.
 *
 * Returns the delta since before the change so it can be relayed as an
 * ordinary update. Peers reconcile it into the document they already have,
 * which is why an agent edit does not cost anyone their cursor or undo
 * history the way an epoch rotation would.
 */
function mutate(target: Document, change: () => boolean): Mutation | undefined {
	let vector = Y.encodeStateVector(target.doc);
	let changed = false;
	let failure: unknown;

	target.editor.update(
		() => {
			try {
				changed = change();
			} catch (err) {
				failure = err;
			}
		},
		{ discrete: true },
	);
	if (failure) throw failure;
	if (!changed) return undefined;

	return { update: Y.encodeStateAsUpdate(target.doc, vector), source: project(target) };
}

/** Append a questionnaire to the plan. */
export function insertQuestionnaire(
	target: Document,
	value: Questionnaire,
): Mutation | undefined {
	return mutate(target, () => {
		$getRoot().append($createQuestionnaireNode(value));
		return true;
	});
}

/**
 * Write a resolved answer into the document.
 *
 * The sidecar record is authoritative; this only makes the plan read correctly
 * on its own. A discrepancy means the projection is stale, never that the
 * document has decided something different.
 */
export function projectAnswer(
	target: Document,
	id: string,
	answers: Record<string, string>,
): Mutation | undefined {
	return mutate(target, () => {
		let found = false;
		for (let node of $nodesOfType(QuestionnaireNode)) {
			if (node.getId() !== id) continue;
			found = true;
			let value = node.getQuestionnaire();
			node.setQuestionnaire({
				...value,
				questions: value.questions.map(question => {
					let answer = answers[question.id];
					return answer === undefined ? question : { ...question, answer };
				}),
			});
		}
		return found;
	});
}

/** Take a questionnaire out of the plan, leaving its record as history. */
export function removeQuestionnaire(target: Document, id: string): Mutation | undefined {
	return mutate(target, () => {
		let found = false;
		for (let node of $nodesOfType(QuestionnaireNode)) {
			if (node.getId() !== id) continue;
			found = true;
			node.remove();
		}
		return found;
	});
}

/**
 * Reconcile a validated sequence of top-level blocks into the live document.
 *
 * Object identity in `after` is what distinguishes a block that came from the
 * source the agent read from one it has just written. The former map to the
 * Lexical nodes already there, so they keep their keys through the edit and
 * through every move around them — which is why an agent rewriting one
 * paragraph does not cost everyone else their cursor, their selection or their
 * undo history. Only genuinely new blocks are constructed, and they have to be
 * constructed in this editor: Lexical nodes cannot be carried in from another.
 */
export function reconcile(
	target: Document,
	before: RootContent[],
	after: RootContent[],
): Mutation | undefined {
	return mutate(target, () => {
		let root = $getRoot();
		let all = root.getChildren();

		// An empty paragraph is a caret affordance, not a block the agent can
		// address, so it has no place in the mapping and this edit may remove it.
		let live = all.filter(node => !($isParagraphNode(node) && node.getChildrenSize() === 0));
		if (live.length !== before.length) {
			throw new Error("the plan changed while the edit was being applied");
		}

		let nodes = new Map<RootContent, LexicalNode>();
		before.forEach((node, index) => nodes.set(node, live[index]!));

		let fresh = after.filter(node => !nodes.has(node));
		let created = $createPlanNodes(
			{ type: "root", children: fresh } as Root,
			{ registry: schema(), validate: false },
		);
		if (created.length !== fresh.length) {
			throw new Error("a plan block did not import to exactly one node");
		}
		fresh.forEach((node, index) => nodes.set(node, created[index]!));

		root.splice(
			0,
			all.length,
			after.map(node => {
				let found = nodes.get(node);
				if (!found) throw new Error("a plan block has no live node");
				return found;
			}),
		);
		return true;
	});
}

// -- anchors ---------------------------------------------------------------

/**
 * Where a decision sits in the prose.
 *
 * A Yjs relative position rather than an index, because an index is wrong the
 * moment anybody inserts a paragraph above it. The relative position survives
 * edits around the block it names; the digest is what recovers it when the
 * position cannot be resolved at all — after the block moves, or after an
 * epoch rotation throws away the history the position was expressed in.
 */

/** Blocks an anchor can name: the ones the source addresses. */
function addressable(): LexicalNode[] {
	return $getRoot().getChildren().filter(
		node => !($isParagraphNode(node) && node.getChildrenSize() === 0),
	);
}

export function digest(source: string): string {
	return `sha256:${createHash("sha256").update(source).digest("hex")}`;
}

/** Canonical hash of each top-level block, in order. */
export function digests(target: Document): string[] {
	return parse(project(target)).children.map(node =>
		digest(serialize({ type: "root", children: [node] }))
	);
}

function anchorForKey(target: Document, key: string | undefined, hash: string): Anchor {
	let collab = key ? target.binding.collabNodeMap.get(key) : undefined;
	let type = collab?.getSharedType();
	if (!type) throw new Error("anchored block has no collaborative identity");

	return {
		epoch: target.epoch,
		position: Buffer.from(
			Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(type, 0, -1)),
		).toString("base64"),
		digest: hash,
	};
}

/** Anchor the block currently at `index`. */
export function anchorAt(target: Document, index: number, hash: string): Anchor {
	let key: string | undefined;
	target.editor.getEditorState().read(() => {
		key = addressable()[index]?.getKey();
	});
	return anchorForKey(target, key, hash);
}

/** The local node an anchor names, if it still names one. */
export function resolveAnchor(target: Document, anchor: Anchor): string | undefined {
	if (anchor.epoch !== target.epoch) return undefined;
	try {
		let relative = Y.decodeRelativePosition(Buffer.from(anchor.position, "base64"));
		let absolute = Y.createAbsolutePositionFromRelativePosition(relative, target.doc, false);
		if (!absolute) return undefined;
		for (let [key, collab] of target.binding.collabNodeMap) {
			if (collab.getSharedType() === absolute.type) return key;
		}
	} catch {
		// A position from a history this document no longer has. The digest is
		// the fallback, and the caller is about to try it.
	}
	return undefined;
}

/**
 * Bring anchors forward onto the document as it is now.
 *
 * Resolvable positions are re-expressed against the block they still name, so
 * a digest kept up to date with the content. Anything that cannot be resolved
 * is matched by digest — and only when exactly one block matches, because two
 * identical paragraphs give no way to tell which was meant. The rest are kept
 * and marked orphaned rather than guessed at: a relationship pointing at the
 * wrong passage is worse than one admitting it is lost.
 */
export function rebase(target: Document, anchors: Anchor[]): Anchor[] {
	let hashes = digests(target);
	let keys: string[] = [];
	target.editor.getEditorState().read(() => {
		keys = addressable().map(node => node.getKey());
	});

	let byDigest = new Map<string, string[]>();
	hashes.forEach((hash, index) => {
		let key = keys[index];
		if (!key) return;
		byDigest.set(hash, [...byDigest.get(hash) ?? [], key]);
	});

	return anchors.map(anchor => {
		if (anchor.orphaned) return { ...anchor, epoch: target.epoch };

		let key = resolveAnchor(target, anchor);
		if (key) {
			let index = keys.indexOf(key);
			let hash = hashes[index];
			if (hash) return anchorForKey(target, key, hash);
		}

		let matches = byDigest.get(anchor.digest) ?? [];
		return matches.length === 1
			? anchorForKey(target, matches[0], anchor.digest)
			: { ...anchor, epoch: target.epoch, orphaned: true as const };
	});
}
