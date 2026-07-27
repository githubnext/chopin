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

import { createHeadlessEditor } from "@lexical/headless";
import { createYjsBinding, syncLexicalUpdateToYjs, syncYjsChangesToLexical } from "@lexical/yjs";
import * as Y from "yjs";

import {
	$exportPlan,
	$importPlan,
	exportPlan,
	limits,
	parse,
	PlanValidationError,
	registry as buildRegistry,
	ulid,
} from "@chopin/dialect";

import type { Binding, Provider } from "@lexical/yjs";
import type { LexicalEditor } from "lexical";
import type { Registry } from "@chopin/dialect";

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
