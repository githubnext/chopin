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
	$createDecisionNode,
	$createPlanNodes,
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
import { $getAnchorAndFocusForUserState } from "@lexical/yjs";
import * as Questionnaires from "./questionnaires";
import {
	$createParagraphNode,
	$getNodeByKey,
	$getRoot,
	$isElementNode,
	$isParagraphNode,
	$nodesOfType,
} from "lexical";

import type { Binding, Provider } from "@lexical/yjs";
import type { LexicalEditor, LexicalNode } from "lexical";
import type { Root, RootContent } from "mdast";
import type { Decision, Questionnaire, Registry } from "@chopin/dialect";
import type { Plan } from "@chopin/protocol";

type Anchor = Plan.Anchor;
type Passage = Plan.Passage;

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
	if (!source.trim()) {
		// A shared empty paragraph gives every joining client the same caret.
		target.editor.update(() => {
			$getRoot().append($createParagraphNode());
		}, { discrete: true });
		return;
	}

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

export type RestoredUpdate = { epoch: string; update: Uint8Array };

/** Restore a durable Yjs checkpoint and every accepted update after it. */
export async function restore(
	epoch: string,
	checkpoint: Uint8Array,
	source: string,
	journal: RestoredUpdate[],
): Promise<Document> {
	let restored = build(epoch);
	try {
		Y.applyUpdate(restored.doc, checkpoint, REMOTE);
		await settle();
		if (project(restored) !== source) {
			throw new Error("stored plan source does not match its Yjs checkpoint");
		}

		for (let item of journal) {
			if (item.epoch !== restored.epoch) {
				throw new Error("stored plan journal changes epoch without a checkpoint");
			}
			Y.applyUpdate(restored.doc, item.update, REMOTE);
			await settle();
			project(restored);
		}
		await settle();
		restored.checkpoint = Y.encodeStateAsUpdate(restored.doc);
		return restored;
	} catch (err) {
		restored.doc.destroy();
		throw err;
	}
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

export type QuestionnaireInsertion = Questionnaires.QuestionnaireInsertion;

export function insertQuestionnaires(
	target: Document,
	insertions: QuestionnaireInsertion[],
): Mutation | undefined {
	return Questionnaires.insert({
		digests: () => digests(target),
		mutate: change => mutate(target, change),
	}, insertions);
}

/** Append one questionnaire to the plan. */
export function insertQuestionnaire(target: Document, value: Questionnaire): Mutation | undefined {
	return insertQuestionnaires(target, [{ value }]);
}

export type QuestionnairePlacement = Questionnaires.QuestionnairePlacement;

export function placeQuestionnaires(
	target: Document,
	placements: QuestionnairePlacement[],
): Mutation | undefined {
	return Questionnaires.place({
		digests: () => digests(target),
		mutate: change => mutate(target, change),
	}, placements);
}

/**
 * Append an accepted comment thread to the plan.
 *
 * At the end rather than beside the prose it concerns: the node renders as
 * nothing, so its position only affects how `plan.mdx` reads, and decisions
 * gathered in one place read as the record they are. Written once and never
 * revised — what marks the prose is the passage, which keeps moving.
 */
export function insertDecision(target: Document, value: Decision): Mutation | undefined {
	return mutate(target, () => {
		$getRoot().append($createDecisionNode(value));
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
	settled?: { by: string; at: string },
): Mutation | undefined {
	return mutate(target, () => {
		let found = false;
		for (let node of $nodesOfType(QuestionnaireNode)) {
			if (node.getId() !== id) continue;
			found = true;
			let value = node.getQuestionnaire();
			node.setQuestionnaire({
				...value,
				// Resolution belongs to the questionnaire, not each answer.
				...(settled ? { by: settled.by, at: settled.at } : {}),
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

/** Whether the source contains plan content rather than only decision widgets. */
export function hasProse(target: Document): boolean {
	return parse(project(target)).children.some(node =>
		node.type !== "mdxJsxFlowElement"
		|| (node.name !== "Questionnaire" && node.name !== "Decision")
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

/**
 * A position at the end of the block at `index`.
 *
 * Where an edit finished rather than where it started, which is the difference
 * between a caret that says the agent has written this and one that looks like
 * it is about to. An anchor is deliberately the other way round — it names a
 * block, and the start is the stable end of one — so this is its own function
 * rather than a parameter.
 *
 * Raw, because a cursor carries positions as they are: only an anchor needs
 * the base64 and the digest that go with travelling as a durable reference.
 */
export function endOf(target: Document, index: number): Y.RelativePosition {
	let key: string | undefined;
	target.editor.getEditorState().read(() => {
		key = addressable()[index]?.getKey();
	});

	let collab = key ? target.binding.collabNodeMap.get(key) : undefined;
	let type = collab?.getSharedType();
	if (!type) throw new Error("block has no collaborative identity");

	// A decorator block — a questionnaire, a decision — is a map rather than a
	// sequence, so it has no inside for a caret to be at the end of. Nought is
	// the only position it has. Asked by shape rather than with `instanceof`,
	// which is the check that breaks when two copies of Yjs are loaded.
	let end = "length" in type ? type.length : 0;

	return Y.createRelativePositionFromTypeIndex(type, end, -1);
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

/** Whether an anchor resolves to the addressable block at this current index. */
export function matchesAnchor(target: Document, anchor: Anchor, index: number): boolean {
	let key = resolveAnchor(target, anchor);
	if (!key) return false;
	let found: string | undefined;
	target.editor.getEditorState().read(() => {
		found = addressable()[index]?.getKey();
	});
	return key === found;
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

// -- passages --------------------------------------------------------------

/**
 * A phrase of the plan, to the character.
 *
 * An anchor names a whole block, which is the right grain for a decision and
 * the wrong one for a remark about a single sentence. A passage is therefore
 * the block run plus a range inside it, and the range is expressed twice for
 * the same reason the block is: relative positions, so it stretches as somebody
 * types inside the phrase, and the quoted text, which finds it again when they
 * cannot be resolved.
 *
 * The quote is a bounded locator, not the whole phrase, so `length` carries the
 * real extent — find the prefix, then run on. That is what lets a passage be
 * longer than the bound instead of being refused for it.
 */

/** Blocks are one string; this joins them. Only consistency matters. */
const RUN = "\n";

/** One text node's place in a block run's plain text. */
type Span = { key: string; start: number; length: number };

/**
 * A block run as one string, with where each of its text nodes sits in it.
 *
 * Call inside a read. Blocks with no text — a decorator, a rule — contribute
 * nothing but still take their separator, so a run can span across one.
 */
function runOf(nodes: LexicalNode[]): { text: string; spans: Span[] } {
	let spans: Span[] = [];
	let text = "";

	for (let [i, node] of nodes.entries()) {
		if (i > 0) text += RUN;
		if (!$isElementNode(node)) continue;
		for (let leaf of node.getAllTextNodes()) {
			let value = leaf.getTextContent();
			spans.push({ key: leaf.getKey(), start: text.length, length: value.length });
			text += value;
		}
	}

	return { text, spans };
}

/** Where an index in the run's text sits, as a Lexical text point. */
function place(spans: Span[], index: number): { key: string; offset: number } | undefined {
	for (let span of spans) {
		// An index inside a separator lands at the start of the block after it.
		if (index <= span.start + span.length) {
			return { key: span.key, offset: Math.max(0, index - span.start) };
		}
	}
	let last = spans.at(-1);
	return last ? { key: last.key, offset: last.length } : undefined;
}

/** The run index of a Lexical text point, if the point is in this run. */
function indexOfPoint(spans: Span[], key: string | null, offset: number): number | undefined {
	if (!key) return undefined;
	for (let span of spans) {
		if (span.key === key) return span.start + Math.min(offset, span.length);
	}
	return undefined;
}

/**
 * Where the quote is now, or nothing if that cannot be said.
 *
 * The recorded offset breaks ties, because a phrase can legitimately appear
 * twice in one paragraph. Two occurrences equally near it recover neither —
 * the rule `rebase` applies to two identical blocks, for the same reason.
 */
function seek(text: string, quote: string, offset: number): number | undefined {
	if (!quote) return undefined;

	let found: number[] = [];
	for (let at = text.indexOf(quote); at !== -1; at = text.indexOf(quote, at + 1)) found.push(at);
	if (found.length === 0) return undefined;
	if (found.length === 1) return found[0];

	let best = found.reduce((a, b) => Math.abs(a - offset) <= Math.abs(b - offset) ? a : b);
	let near = Math.abs(best - offset);
	return found.filter(at => Math.abs(at - offset) === near).length === 1 ? best : undefined;
}

/** The parts of a collab text node this needs, named structurally. */
type CollabText = { _parent?: { getSharedType(): unknown }; getOffset(): number };

/**
 * A Yjs position for a point inside a block's text.
 *
 * `@lexical/yjs` computes this for every remote cursor and does not export it,
 * so the arithmetic is repeated here: a text node's characters live in its
 * parent's `XmlText`, one slot past the node's own entry, which is the `+ 1`.
 * The inverse *is* exported, so this is the only half that is ours to keep
 * right — and it is pinned by `passages.test.ts` rather than by inspection.
 */
function positionAt(target: Document, key: string, offset: number): string {
	let collab = target.binding.collabNodeMap.get(key) as CollabText | undefined;
	let type = collab?._parent?.getSharedType();
	if (!collab || !(type instanceof Y.XmlText)) {
		throw new Error("passage names text with no collaborative identity");
	}

	let base = collab.getOffset();
	if (base === -1) throw new Error("passage names text that is no longer in the document");

	return Buffer.from(
		Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(type, base + 1 + offset)),
	).toString("base64");
}

/** The nodes a passage's blocks name, if every one of them still resolves. */
function runNodes(target: Document, blocks: Anchor[]): LexicalNode[] | undefined {
	let keys = blocks.map(block => resolveAnchor(target, block));
	if (keys.some(key => !key)) return undefined;

	let nodes: LexicalNode[] = [];
	target.editor.getEditorState().read(() => {
		for (let key of keys) {
			let node = $getNodeByKey(key!);
			if (node) nodes.push(node);
		}
	});

	return nodes.length === blocks.length ? nodes : undefined;
}

/** Build a passage over a resolved run, from a range in its text. */
function cut(
	target: Document,
	blocks: Anchor[],
	run: { text: string; spans: Span[] },
	from: number,
	to: number,
): Passage {
	let start = place(run.spans, from);
	let end = place(run.spans, to);
	if (!start || !end) throw new Error("passage names a run with no text in it");

	return {
		blocks,
		start: positionAt(target, start.key, start.offset),
		end: positionAt(target, end.key, end.offset),
		quote: run.text.slice(from, to).slice(0, limits.MAX_QUOTE),
		offset: from,
		length: to - from,
	};
}

/**
 * Mark a phrase, from what the client read.
 *
 * Finding the quote is the concurrency check. A digest would only prove the
 * blocks are byte-identical, which is both stricter than needed and impossible
 * for a client to compute without re-serialising the document; the quote tests
 * whether the sentence somebody selected is still there, which is the thing
 * that matters. If the plan moved underneath, it is not found and this refuses
 * rather than marking whatever sits at that index now.
 *
 * The offset is a hint rather than a coordinate — the quote is searched for
 * near it — so the client's idea of where text begins never has to agree with
 * this one exactly.
 */
export function passageAt(
	target: Document,
	blocks: number[],
	quote: string,
	offset: number,
	length: number,
): Passage {
	if (blocks.length === 0) throw new Error("a passage must name at least one block");

	let current = digests(target);
	let anchors: Anchor[] = [];
	for (let index of blocks) {
		let hash = current[index];
		if (!hash) throw new Error(`no block at index ${index}`);
		anchors.push(anchorAt(target, index, hash));
	}

	let nodes = runNodes(target, anchors);
	if (!nodes) throw new Error("a block in the passage has no collaborative identity");

	let run = { text: "", spans: [] as Span[] };
	target.editor.getEditorState().read(() => {
		run = runOf(nodes);
	});

	let from = seek(run.text, quote, offset);
	if (from === undefined) throw new Error("the quoted text is not in those blocks");

	return cut(target, anchors, run, from, Math.min(from + length, run.text.length));
}

/** The Lexical points a passage names, if it still names any. */
export function locate(
	target: Document,
	passage: Passage,
): { anchorKey: string; anchorOffset: number; focusKey: string; focusOffset: number } | undefined {
	if (passage.drifted) return undefined;
	if (passage.blocks[0]?.epoch !== target.epoch) return undefined;

	try {
		let state = {
			anchorPos: Y.decodeRelativePosition(Buffer.from(passage.start, "base64")),
			focusPos: Y.decodeRelativePosition(Buffer.from(passage.end, "base64")),
			color: "",
			focusing: false,
			name: "",
			awarenessData: {},
		};

		let found: ReturnType<typeof $getAnchorAndFocusForUserState> | undefined;
		target.editor.getEditorState().read(() => {
			found = $getAnchorAndFocusForUserState(target.binding, state);
		});
		if (!found) return undefined;

		let { anchorKey, anchorOffset, focusKey, focusOffset } = found;
		if (!anchorKey || !focusKey) return undefined;
		return { anchorKey, anchorOffset: anchorOffset ?? 0, focusKey, focusOffset: focusOffset ?? 0 };
	} catch {
		// A position from a history this document no longer holds. The quote is
		// the fallback, and `rebasePassage` is about to try it.
		return undefined;
	}
}

/** The plain text of a run of blocks, addressed the way the agent addresses them. */
export function blockText(target: Document, indices: number[]): string {
	let text = "";
	target.editor.getEditorState().read(() => {
		let all = addressable();
		let nodes = indices.map(index => all[index]).filter(node => !!node);
		if (nodes.length === indices.length) text = runOf(nodes).text;
	});
	return text;
}

/** The current text of the blocks a passage covers, for saying what it now reads. */
export function passageText(target: Document, passage: Passage): string | undefined {
	let nodes = runNodes(target, passage.blocks);
	if (!nodes) return undefined;

	let text = "";
	target.editor.getEditorState().read(() => {
		text = runOf(nodes).text;
	});
	return text;
}

/**
 * Bring a passage forward onto the document as it is now.
 *
 * Same ladder as an anchor, one level finer. The blocks are rebased first,
 * because a range means nothing without them. Positions that still resolve are
 * kept and the quote refreshed from what they now cover, so the fallback keeps
 * describing the prose rather than a memory of it. Positions that do not are
 * re-derived by finding the quote. Anything left over is marked drifted and
 * kept: a comment pointing at the wrong sentence is worse than one admitting
 * its sentence is gone, and the thread is still worth reading either way.
 */
export function rebasePassage(target: Document, passage: Passage): Passage {
	let resolvable = !passage.drifted && passage.blocks[0]?.epoch === target.epoch;
	let blocks = rebase(target, passage.blocks);
	let nodes = blocks.some(block => block.orphaned) ? undefined : runNodes(target, blocks);
	if (!nodes) return { ...passage, blocks, drifted: true };

	let run = { text: "", spans: [] as Span[] };
	target.editor.getEditorState().read(() => {
		run = runOf(nodes);
	});

	if (resolvable) {
		let points = locate(target, { ...passage, blocks: passage.blocks });
		let from = points && indexOfPoint(run.spans, points.anchorKey, points.anchorOffset);
		let to = points && indexOfPoint(run.spans, points.focusKey, points.focusOffset);

		if (from !== undefined && to !== undefined) {
			try {
				return cut(target, blocks, run, Math.min(from, to), Math.max(from, to));
			} catch {
				// The points resolved but no longer sit in text we can address.
				// Fall through to the quote.
			}
		}
	}

	let found = seek(run.text, passage.quote, passage.offset);
	if (found === undefined) return { ...passage, blocks, drifted: true };

	try {
		return cut(target, blocks, run, found, Math.min(found + passage.length, run.text.length));
	} catch {
		return { ...passage, blocks, drifted: true };
	}
}
