/**
 * Per-person undo over a shared document.
 *
 * Real Lexical and real Yjs on both ends. What decides correctness is which
 * Yjs transactions the undo manager tracks and which stack items it refuses,
 * and both are visible here without a browser. The keyboard path is covered
 * by `e2e/undo.e2e.ts`.
 */

import { describe, expect, it } from "bun:test";
import { createHeadlessEditor } from "@lexical/headless";
import { createYjsBinding, syncLexicalUpdateToYjs, syncYjsChangesToLexical } from "@lexical/yjs";
import {
	$createParagraphNode,
	$createTextNode,
	$getRoot,
	$isDecoratorNode,
	$isParagraphNode,
	REDO_COMMAND,
	UNDO_COMMAND,
} from "lexical";
import * as Y from "yjs";

import { $createDecisionNode, $createResearchNode, importPlan, registry } from "@chopin/dialect";

import { planUndoManager, registerPlanHistory, touchesProjection } from "./history";

import type { Binding, Provider } from "@lexical/yjs";
import type { LexicalEditor } from "lexical";

const REGISTRY = registry();

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

const REMOTE = Symbol("remote");

type Person = { editor: LexicalEditor; binding: Binding; doc: Y.Doc };

function bound(doc: Y.Doc): Person {
	let editor = createHeadlessEditor({
		nodes: REGISTRY.nodes,
		onError(err) {
			throw err;
		},
	});
	let binding = createYjsBinding({ editor, id: "plan", doc, docMap: new Map([["plan", doc]]) });
	editor.registerUpdateListener(
		({ dirtyElements, dirtyLeaves, editorState, normalizedNodes, prevEditorState, tags }) => {
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
	return { editor, binding, doc };
}

/** A browser: the binding as `collaboration.tsx` wires it, plus MDXEditor's trailing paragraph. */
function person(update: Uint8Array): Person {
	let found = bound(new Y.Doc());
	let { editor, binding, doc } = found;
	let history = registerPlanHistory(editor, binding);
	binding.root.getSharedType().observeDeep((events, transaction) => {
		if (transaction.origin === binding) return;
		history.react();
		let undone = transaction.origin instanceof Y.UndoManager;
		syncYjsChangesToLexical(binding, PROVIDER, events, undone);
	});
	editor.registerUpdateListener(({ editorState }) => {
		let last = editorState.read(() => $getRoot().getLastChild());
		if ($isDecoratorNode(last)) {
			editor.update(() => void $getRoot().append($createParagraphNode()), { discrete: true });
		}
	});
	Y.applyUpdate(doc, update, REMOTE);
	return found;
}

/**
 * Two people in one room with the server, every update relayed to the others
 * as a remote one. The server is a bare binding, as the Planner's edits are.
 */
async function room(source: string): Promise<{ me: Person; peer: Person; server: Person }> {
	let server = bound(new Y.Doc());
	importPlan(server.editor, source, { registry: REGISTRY });
	let seeded = Y.encodeStateAsUpdate(server.doc);
	let me = person(seeded);
	let peer = person(seeded);
	let everyone = [me, peer, server];
	for (let from of everyone) {
		from.doc.on("update", (update: Uint8Array, origin: unknown) => {
			if (origin === REMOTE) return;
			for (let to of everyone) if (to !== from) Y.applyUpdate(to.doc, update, REMOTE);
		});
	}
	await settle();
	return { me, peer, server };
}

async function settle(): Promise<void> {
	await new Promise(resolve => setTimeout(resolve, 0));
}

function text(editor: LexicalEditor): string {
	return editor.getEditorState().read(() => $getRoot().getTextContent());
}

function types(editor: LexicalEditor): string[] {
	return editor.getEditorState().read(() => $getRoot().getChildren().map(node => node.getType()));
}

/** Append to the nth paragraph, as typing would. */
function type(editor: LexicalEditor, value: string, index = 0) {
	editor.update(() => {
		let paragraph = $getRoot().getChildren().filter($isParagraphNode)[index];
		if (!paragraph) throw new Error("no paragraph to type into");
		paragraph.append($createTextNode(value));
	}, { discrete: true });
}

const DECISION = {
	id: "01K0N4Y9VG9DHBFZB6HC89E2AA",
	quote: "Keep the pilot small.",
	by: "octocat",
	at: "2026-10-07T00:00:00.000Z",
	notes: [],
};

describe("plan history", () => {
	it("undoes and redoes this person's typing", async () => {
		let { me } = await room("Start here.\n");

		type(me.editor, " Mine.");
		await settle();
		expect(text(me.editor)).toBe("Start here. Mine.");

		me.editor.dispatchCommand(UNDO_COMMAND, undefined);
		await settle();
		expect(text(me.editor)).toBe("Start here.");

		me.editor.dispatchCommand(REDO_COMMAND, undefined);
		await settle();
		expect(text(me.editor)).toBe("Start here. Mine.");
	});

	it("leaves a peer's edit alone", async () => {
		let { me, peer } = await room("Mine.\n\nTheirs.\n");

		type(me.editor, " Typed by me.");
		await settle();
		type(peer.editor, " Typed by them.", 1);
		await settle();
		expect(text(me.editor)).toContain("Typed by them.");

		me.editor.dispatchCommand(UNDO_COMMAND, undefined);
		await settle();
		expect(text(me.editor)).not.toContain("Typed by me.");
		expect(text(me.editor)).toContain("Typed by them.");
		expect(text(peer.editor)).toBe(text(me.editor));
	});

	it("undoes typing around a projection the server inserted afterwards", async () => {
		let { me, peer } = await room("Start here.\n");

		me.editor.update(() => {
			let paragraph = $createParagraphNode().append($createTextNode("A new paragraph."));
			$getRoot().append(paragraph);
		}, { discrete: true });
		await settle();
		peer.editor.update(() => {
			$getRoot().getLastChildOrThrow().insertAfter($createDecisionNode(DECISION));
		}, { discrete: true });
		await settle();
		expect(types(me.editor)).toContain("plan-decision");

		me.editor.dispatchCommand(UNDO_COMMAND, undefined);
		await settle();
		expect(text(me.editor)).not.toContain("A new paragraph.");
		expect(types(me.editor)).toContain("plan-decision");
		expect(types(peer.editor)).toEqual(types(me.editor));
	});

	it("will not undo past a projection this person inserted", async () => {
		let { me } = await room("Start here.\n");

		me.editor.update(() => {
			$getRoot().getFirstChildOrThrow().insertAfter(
				$createResearchNode("01K0N4Y9VG9DHBFZB6HC89E2AB"),
			);
		}, { discrete: true });
		await settle();
		let inserted = text(me.editor);
		let before = Y.encodeStateVector(me.doc);

		me.editor.dispatchCommand(UNDO_COMMAND, undefined);
		await settle();
		expect(types(me.editor)).toContain("plan-research");
		// Nothing was sent: a removed reference would be refused by the server.
		expect(Y.encodeStateVector(me.doc)).toEqual(before);

		// The refused step ends the history rather than blocking it forever.
		type(me.editor, " Later.");
		await settle();
		me.editor.dispatchCommand(UNDO_COMMAND, undefined);
		await settle();
		expect(text(me.editor)).toBe(inserted);
		expect(types(me.editor)).toContain("plan-research");
	});

	it("does nothing while the editor is read-only", async () => {
		let { me } = await room("Start here.\n");
		type(me.editor, " Mine.");
		await settle();

		me.editor.setEditable(false);
		me.editor.dispatchCommand(UNDO_COMMAND, undefined);
		await settle();
		expect(text(me.editor)).toBe("Start here. Mine.");
	});
});

describe("plan history with peers", () => {
	it("keeps a paragraph this person created once a peer has typed in it", async () => {
		let { me, peer } = await room("Start here.\n");

		me.editor.update(() => {
			$getRoot().append($createParagraphNode().append($createTextNode("Mine.")));
		}, { discrete: true });
		await settle();
		type(peer.editor, " Theirs.", 1);
		await settle();

		me.editor.dispatchCommand(UNDO_COMMAND, undefined);
		await settle();
		expect(text(me.editor)).not.toContain("Mine.");
		expect(text(me.editor)).toContain("Theirs.");
		expect(text(peer.editor)).toBe(text(me.editor));
	});

	it("does not undo what this client wrote in reaction to a remote card", async () => {
		let { me, server } = await room("Start here.\n");

		type(me.editor, " Mine.");
		await settle();
		server.editor.update(() => {
			$getRoot().append($createDecisionNode(DECISION));
		}, { discrete: true });
		await settle();
		let shape = types(me.editor);
		expect(shape.at(-1)).toBe("paragraph");
		expect(shape).toContain("plan-decision");
		let last = () => me.binding.root.getSharedType().toDelta().at(-1)?.insert;
		let trailing = last();

		me.editor.dispatchCommand(UNDO_COMMAND, undefined);
		await settle();
		expect(text(me.editor)).not.toContain("Mine.");
		expect(types(me.editor)).toEqual(shape);
		// The same paragraph, not one removed by the undo and appended again.
		expect(last()).toBe(trailing);
	});
});

describe("touchesProjection", () => {
	it("sees the removal of a projection this person inserted", () => {
		let doc = new Y.Doc();
		let root = doc.get("root", Y.XmlText);
		let local = Symbol("local");
		let manager = planUndoManager(root, local);

		doc.transact(() => root.insertEmbed(0, new Y.XmlText()), local);
		expect(touchesProjection(doc, manager.undoStack[0]!)).toBe(false);

		let projection = new Y.XmlElement();
		doc.transact(() => {
			root.insertEmbed(0, projection);
			projection.setAttribute("__type", "plan-research");
		}, local);
		expect(touchesProjection(doc, manager.undoStack.at(-1)!)).toBe(true);
	});

	it("sees the restoration of a projection this person moved away", () => {
		let doc = new Y.Doc();
		let root = doc.get("root", Y.XmlText);
		let projection = new Y.XmlElement();
		doc.transact(() => {
			root.insertEmbed(0, projection);
			projection.setAttribute("__type", "plan-questionnaire");
		}, REMOTE);
		let local = Symbol("local");
		let manager = planUndoManager(root, local);

		doc.transact(() => root.delete(0, 1), local);
		expect(touchesProjection(doc, manager.undoStack[0]!)).toBe(true);
	});

	it("keeps a remote projection placed inside a block this person created", () => {
		let doc = new Y.Doc();
		let root = doc.get("root", Y.XmlText);
		let local = Symbol("local");
		let manager = planUndoManager(root, local);

		let block = new Y.XmlText();
		doc.transact(() => root.insertEmbed(0, block), local);
		// Another client's projection, as the server would place it.
		let server = new Y.Doc();
		Y.applyUpdate(server, Y.encodeStateAsUpdate(doc));
		let projection = new Y.XmlElement();
		let host = server.get("root", Y.XmlText).toDelta()[0].insert as Y.XmlText;
		server.transact(() => {
			host.insertEmbed(0, projection);
			projection.setAttribute("__type", "plan-decision");
		});
		Y.applyUpdate(doc, Y.encodeStateAsUpdate(server, Y.encodeStateVector(doc)), REMOTE);

		expect(touchesProjection(doc, manager.undoStack[0]!)).toBe(false);
		manager.undo();
		expect(block.toDelta()[0]?.insert).toBeInstanceOf(Y.XmlElement);
		expect(root.toDelta()).toHaveLength(1);
	});
});
