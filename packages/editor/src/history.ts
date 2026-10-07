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
function projections(source: string): Set<string> {
	let found = new Set<string>();
	let walk = (node: { type: string; name?: string | null; children?: unknown[] }) => {
		if (node.type === "mdxJsxFlowElement" && node.name && PROTECTED.has(node.name)) {
			found.add(serialize({ type: "root", children: [node] } as never));
		}
		for (let child of node.children ?? []) walk(child as typeof node);
	};
	walk(parse(source) as never);
	return found;
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

function same(a: Set<string>, b: Set<string>): boolean {
	return a.size === b.size && [...a].every(value => b.has(value));
}

/**
 * Whether the next undo or redo is one the room will accept.
 *
 * Runs it on a copy, including Yjs passing over steps that no longer change
 * anything, and checks that it deletes nothing another client wrote, leaves
 * every protected projection exactly as it is, exports as valid MDX, and reads
 * the same from a fresh load as it does applied to a live editor.
 */
export function safe(manager: Y.UndoManager, direction: "undo" | "redo"): boolean {
	let doc = manager.doc;
	let scope = manager.scope[0];
	if (!(scope instanceof Y.AbstractType)) return false;
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

		let deleted: Y.Item[] = [];
		copy.on("afterTransaction", (transaction: Y.Transaction) => {
			if (transaction.origin !== replay) return;
			Y.iterateDeletedStructs(transaction, transaction.deleteSet, struct => {
				if (struct instanceof Y.Item) deleted.push(struct);
			});
		});
		replay[direction]();
		if (deleted.some(item => item.id.client !== doc.clientID)) return false;

		flush(live);
		let result = source(live);
		let fresh = new Y.Doc();
		let loaded = mirror(fresh);
		Y.applyUpdate(fresh, Y.encodeStateAsUpdate(copy));
		flush(loaded);
		return result === source(loaded) && same(before, projections(result));
	} catch {
		return false;
	} finally {
		copy.destroy();
	}
}

export type PlanHistory = {
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
	captureTimeout = 500,
): PlanHistory {
	let manager = new Y.UndoManager(binding.root.getSharedType(), {
		trackedOrigins: new Set([binding]),
		captureTimeout,
	});

	let step = (direction: "undo" | "redo") => {
		if (!editor.isEditable()) return false;
		let stack = direction === "undo" ? manager.undoStack : manager.redoStack;
		if (stack.length === 0) return true;
		if (safe(manager, direction)) manager[direction]();
		else manager.clear(direction === "undo", direction === "redo");
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
		react,
		dispose() {
			stopUndo();
			stopRedo();
			manager.destroy();
		},
	};
}
