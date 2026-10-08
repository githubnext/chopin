/**
 * Undo and redo for one person in a shared document.
 *
 * Lexical's own history is suppressed because it would replay whole editor
 * states and so revert everybody's work. A Yjs `UndoManager` that tracks only
 * this binding's transactions undoes this person's edits and leaves peers' and
 * the Planner's alone, because those arrive under the provider's origin.
 *
 * Yjs can reverse a step whatever has happened since, but not every reversal
 * is one the room can accept. Deleting a block a peer has typed in deletes
 * their text; removing or restoring a Questionnaire, Decision or Research
 * projection is refused by the server and rebuilds the epoch for everybody;
 * and a reversal that Lexical applies differently live than it reads from a
 * fresh load leaves a document that no longer opens. So every undo and redo
 * is first run on a copy of the document and checked; one that fails ends the
 * history there instead of running.
 *
 * Edits this client makes in reaction to a remote change are not the person's
 * either. MDXEditor appends a paragraph whenever a card ends the document, and
 * every client does so when the server appends one, so those are left out.
 */

import { COMMAND_PRIORITY_EDITOR, createEditor, REDO_COMMAND, UNDO_COMMAND } from "lexical";
import { createYjsBinding, syncYjsChangesToLexical } from "@lexical/yjs";
import * as Y from "yjs";

import { exportPlan, parse, registry, serialize } from "@chopin/dialect";

import type { Binding, Provider } from "@lexical/yjs";
import type { LexicalEditor } from "lexical";
import type { Registry } from "@chopin/dialect";

/** Components whose records live outside the document. */
const PROTECTED = new Set(["Questionnaire", "Decision", "Research"]);

/** A headless mirror reads no presence. */
const NOBODY = {
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

let shared: Registry | undefined;

/** A headless editor following `doc` the way a browser or the server's room does. */
function mirror(doc: Y.Doc): LexicalEditor {
	shared ??= registry();
	let editor = createEditor({
		nodes: shared.nodes,
		onError(err) {
			throw err;
		},
	});
	let binding = createYjsBinding({ editor, id: "plan", doc, docMap: new Map([["plan", doc]]) });
	binding.root.getSharedType().observeDeep(events => {
		syncYjsChangesToLexical(binding, NOBODY, events, false, () => {});
	});
	return editor;
}

/** Commit whatever the mirror has queued, so it can be read now. */
function flush(editor: LexicalEditor): void {
	editor.update(() => {}, { discrete: true });
}

function source(editor: LexicalEditor): string {
	shared ??= registry();
	return exportPlan(editor, { registry: shared });
}

/**
 * Protected projections as the server compares them: each component's own
 * serialized MDX. Where they sit is free to change.
 */
function projections(source: string): string[] {
	let found: string[] = [];
	let walk = (node: { type: string; name?: string | null; children?: unknown[] }) => {
		if (node.type === "mdxJsxFlowElement" && node.name && PROTECTED.has(node.name)) {
			found.push(serialize({ type: "root", children: [node] } as never));
		}
		for (let child of node.children ?? []) walk(child as typeof node);
	};
	walk(parse(source) as never);
	return found.sort();
}

type Stack = Y.UndoManager["undoStack"];

/** Stack items describe a step by ids, so they replay against a copy of the document. */
function copied(stack: Stack): Stack {
	return stack.map(item => ({
		insertions: item.insertions,
		deletions: item.deletions,
		meta: new Map(),
	})) as Stack;
}

/** Equal as multisets, so a projection restored beside its moved copy is a change. */
function same(a: string[], b: string[]): boolean {
	return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** Element types whose text a typing undo can remove without changing structure. */
const PROSE = new Set(["paragraph", "heading", "quote", "listitem"]);

/** Blocks a typing undo can remove whole when they sit directly in the document. */
const BLOCKS = new Set(["paragraph", "heading", "quote"]);

function prose(type: unknown, kinds = PROSE): type is Y.XmlText {
	return type instanceof Y.XmlText && kinds.has(type.getAttribute("__type") as string);
}

/** Whether removing this run would strand characters someone else typed into it. */
function stranding(doc: Y.Doc, item: Y.Item): boolean {
	for (let next = item.right; next; next = next.right) {
		if (next.content instanceof Y.ContentType) break;
		if (!next.deleted && next.id.client !== doc.clientID) return true;
	}
	return false;
}

/** Whether a block holds only text and text properties, all of it this client's. */
function own(doc: Y.Doc, block: Y.XmlText): boolean {
	for (let child = block._start; child; child = child.right) {
		if (child.deleted) continue;
		if (child.id.client !== doc.clientID) return false;
		if (child.content instanceof Y.ContentType && !(child.content.type instanceof Y.Map)) {
			return false;
		}
	}
	return true;
}

/**
 * Whether undoing this step only removes prose this client typed: characters,
 * the text nodes holding them, and whole top-level paragraphs, headings or
 * quotes nobody else has written in.
 *
 * Removing that cannot touch anyone else's text, a projection, or the shape
 * of anything that remains, and Lexical reads the result the same live as from
 * a fresh load, so it needs no rehearsal. It must also change something, or
 * Yjs would pass over it to the next step unchecked.
 */
export function typing(item: Stack[number], doc: Y.Doc): boolean {
	if (item.deletions.clients.size > 0) return false;
	let created = (type: Y.AbstractType<any>) =>
		!!type._item && Y.isDeleted(item.insertions, type._item.id);
	let changes = false;
	for (let [client, ranges] of item.insertions.clients) {
		let structs = doc.store.clients.get(client);
		if (!structs) return false;
		for (let { clock, len } of ranges) {
			for (let index = Y.findIndexSS(structs, clock); index < structs.length; index++) {
				let struct = structs[index]!;
				if (struct.id.clock >= clock + len) break;
				if (!(struct instanceof Y.Item)) return false;
				let { content, parent } = struct;
				if (!(parent instanceof Y.AbstractType)) return false;
				if (struct.parentSub !== null) {
					// A property of something this same step created.
					if (!created(parent)) return false;
				} else if (content instanceof Y.ContentString) {
					if (!prose(parent)) return false;
				} else if (content instanceof Y.ContentType && content.type instanceof Y.Map) {
					if (!prose(parent) || (!struct.deleted && stranding(doc, struct))) return false;
				} else if (content instanceof Y.ContentType && content.type instanceof Y.XmlText) {
					if (parent._item !== null || !prose(content.type, BLOCKS)) return false;
					if (!struct.deleted && !own(doc, content.type)) return false;
				} else {
					return false;
				}
				if (!struct.deleted) changes = true;
			}
		}
	}
	return changes;
}

type Reason = "others" | "card" | "invalid";

function refuse(reason: Reason, steps = 1): Verdict {
	return { ok: false, reason, steps };
}

export type Verdict =
	| { ok: true }
	| { ok: false; reason: Reason; steps: number };

/**
 * Whether the next undo or redo is one the room will accept.
 *
 * Runs it on a copy, including Yjs passing over steps that no longer change
 * anything, and checks that it deletes nothing another client wrote, leaves
 * every protected projection exactly as it is, exports as valid MDX, and reads
 * the same from a fresh load as it does applied to a live editor. A refusal
 * says how many steps the attempt consumed: the one refused and any empty
 * ones Yjs passed over on the way to it.
 */
export function rehearse(
	manager: Y.UndoManager,
	direction: "undo" | "redo",
	quick = true,
): Verdict {
	let doc = manager.doc;
	let stack = direction === "undo" ? manager.undoStack : manager.redoStack;
	let top = stack.at(-1);
	if (quick && direction === "undo" && top && typing(top, doc)) return { ok: true };

	let scope = manager.scope[0];
	if (!(scope instanceof Y.AbstractType)) return refuse("invalid");
	let key = Y.findRootTypeKey(scope);

	let copy = new Y.Doc({ gc: false });
	let live = mirror(copy);
	Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
	// A redo leaves pointers from undone items to their replacements, and
	// they are local state the encoding does not carry.
	copy.transact(transaction => {
		for (let structs of doc.store.clients.values()) {
			for (let struct of structs) {
				if (!(struct instanceof Y.Item) || !struct.redone) continue;
				let item = Y.getItemCleanStart(transaction, struct.id);
				Y.getItemCleanEnd(
					transaction,
					copy.store,
					Y.createID(struct.id.client, struct.id.clock + struct.length - 1),
				);
				item.redone = struct.redone;
			}
		}
	});

	try {
		flush(live);
		let before = projections(source(live));

		let replay = new Y.UndoManager(copy.get(key, Y.XmlText), { trackedOrigins: new Set() });
		replay.undoStack = copied(manager.undoStack);
		replay.redoStack = copied(manager.redoStack);
		let replayed = direction === "undo" ? replay.undoStack : replay.redoStack;
		let available = replayed.length;

		let deleted: Y.Item[] = [];
		copy.on("afterTransaction", (transaction: Y.Transaction) => {
			if (transaction.origin !== replay) return;
			Y.iterateDeletedStructs(transaction, transaction.deleteSet, struct => {
				if (struct instanceof Y.Item) deleted.push(struct);
			});
		});
		replay[direction]();
		let steps = Math.max(1, available - replayed.length);
		if (deleted.some(item => item.id.client !== doc.clientID)) return refuse("others", steps);

		flush(live);
		let result = source(live);
		let fresh = new Y.Doc();
		let loaded = mirror(fresh);
		Y.applyUpdate(fresh, Y.encodeStateAsUpdate(copy));
		flush(loaded);
		if (result !== source(loaded)) return refuse("invalid", steps);
		if (!same(before, projections(result))) return refuse("card", steps);
		return { ok: true };
	} catch {
		return refuse("invalid");
	} finally {
		copy.destroy();
	}
}

/** Why an undo did not happen, as the person is told. */
export type Refusal = "others" | "change";

export type PlanHistory = {
	manager: Y.UndoManager;
	/** Leave out whatever this client writes in reaction to the current change. */
	react(): void;
	dispose(): void;
};

/**
 * Register undo and redo on an editor bound to a shared document.
 *
 * Bound to one Y.Doc, so an epoch rotation, which remounts the editor over a
 * fresh document, starts an empty history with it.
 */
export function registerPlanHistory(
	editor: LexicalEditor,
	binding: Binding,
	options: { captureTimeout?: number; onRefused?: (reason: Refusal) => void } = {},
): PlanHistory {
	let { captureTimeout = 500, onRefused } = options;
	let manager = new Y.UndoManager(binding.root.getSharedType(), {
		trackedOrigins: new Set([binding]),
		captureTimeout,
	});

	let step = (direction: "undo" | "redo") => {
		if (!editor.isEditable()) return false;
		let stack = direction === "undo" ? manager.undoStack : manager.redoStack;
		if (stack.length === 0) return true;
		let verdict = rehearse(manager, direction);
		if (verdict.ok) {
			manager[direction]();
		} else {
			// Only the refused step goes. Older ones still reverse cleanly or are
			// refused in turn, since each is rehearsed against the room as it is.
			stack.splice(-verdict.steps);
			onRefused?.(verdict.reason === "others" ? "others" : "change");
		}
		return true;
	};

	let stopUndo = editor.registerCommand(UNDO_COMMAND, () => step("undo"), COMMAND_PRIORITY_EDITOR);
	let stopRedo = editor.registerCommand(REDO_COMMAND, () => step("redo"), COMMAND_PRIORITY_EDITOR);

	/*
	 * Lexical commits a remote change in a microtask queued by the caller, and
	 * its listeners react synchronously from there or in microtasks of their
	 * own. Input arrives as a task, so it can never land inside this window,
	 * however busy the room is.
	 */
	let pending = 0;
	let react = () => {
		pending++;
		manager.trackedOrigins.delete(binding);
		let settle = (depth: number) => {
			if (depth > 0) return void queueMicrotask(() => settle(depth - 1));
			if (--pending === 0) manager.trackedOrigins.add(binding);
		};
		settle(4);
	};

	return {
		manager,
		react,
		dispose() {
			stopUndo();
			stopRedo();
			manager.destroy();
		},
	};
}
