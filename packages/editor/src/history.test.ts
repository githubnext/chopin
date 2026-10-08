/**
 * Per-person undo over a shared document.
 *
 * Real Lexical and real Yjs on every end. What decides correctness is which
 * Yjs transactions the undo manager tracks and which reversals it refuses,
 * and both are visible here without a browser. The keyboard path is covered
 * by `e2e/undo.e2e.ts`.
 *
 * After every scenario the document has to read the same from a fresh load as
 * it does in each live editor, and export as valid MDX, because a document
 * that reads differently when reopened is one the server will no longer open.
 */

import { describe, expect, it } from "bun:test";
import { createHeadlessEditor } from "@lexical/headless";
import { createYjsBinding, syncLexicalUpdateToYjs, syncYjsChangesToLexical } from "@lexical/yjs";
import {
	$createParagraphNode,
	$createTextNode,
	$getRoot,
	$isDecoratorNode,
	$isElementNode,
	$isParagraphNode,
	$isTextNode,
	REDO_COMMAND,
	UNDO_COMMAND,
} from "lexical";
import * as Y from "yjs";

import {
	$createDecisionNode,
	$createPlanNodes,
	$createResearchNode,
	exportPlan,
	importPlan,
	parse,
	registry,
} from "@chopin/dialect";

import { registerPlanHistory, rehearse, typing } from "./history";

import type { PlanHistory, Refusal } from "./history";
import type { Binding, Provider } from "@lexical/yjs";
import type { LexicalEditor, LexicalNode, TextNode } from "lexical";

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

type Person = {
	editor: LexicalEditor;
	binding: Binding;
	doc: Y.Doc;
	refusals?: Refusal[];
	history?: PlanHistory;
};

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

/** A bare mirror, as the server's room and a fresh load both are. */
function follower(doc: Y.Doc): Person {
	let found = bound(doc);
	found.binding.root.getSharedType().observeDeep((events, transaction) => {
		if (transaction.origin === found.binding) return;
		syncYjsChangesToLexical(found.binding, PROVIDER, events, false);
	});
	return found;
}

/** A browser: the binding as `collaboration.tsx` wires it, plus MDXEditor's trailing paragraph. */
function person(update: Uint8Array, captureTimeout?: number): Person {
	let found: Person = { ...bound(new Y.Doc()), refusals: [] };
	let { editor, binding, doc } = found;
	let history = registerPlanHistory(editor, binding, {
		captureTimeout,
		onRefused: reason => found.refusals!.push(reason),
	});
	found.history = history;
	binding.root.getSharedType().observeDeep((events, transaction) => {
		if (transaction.origin === binding) return;
		let undone = transaction.origin instanceof Y.UndoManager;
		syncYjsChangesToLexical(binding, PROVIDER, events, undone);
		history.react();
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
 * People in one room with the server, every update relayed to the others as a
 * remote one. The server is a bare mirror, and the Planner edits through it.
 */
async function room(source: string, count = 2, captureTimeout?: number) {
	let server = follower(new Y.Doc());
	importPlan(server.editor, source, { registry: REGISTRY });
	let seeded = Y.encodeStateAsUpdate(server.doc);
	let people = Array.from({ length: count }, () => person(seeded, captureTimeout));
	let everyone = [...people, server];
	for (let from of everyone) {
		from.doc.on("update", (update: Uint8Array, origin: unknown) => {
			if (origin === REMOTE) return;
			for (let to of everyone) if (to !== from) Y.applyUpdate(to.doc, update, REMOTE);
		});
	}
	await settle();
	let [me, peer] = people as [Person, Person];
	return { me, peer, people, server };
}

async function settle(): Promise<void> {
	await new Promise(resolve => setTimeout(resolve, 0));
}

function source(editor: LexicalEditor): string {
	return exportPlan(editor, { registry: REGISTRY });
}

function text(editor: LexicalEditor): string {
	return editor.getEditorState().read(() => $getRoot().getTextContent());
}

function types(editor: LexicalEditor): string[] {
	return editor.getEditorState().read(() => $getRoot().getChildren().map(node => node.getType()));
}

function count(editor: LexicalEditor, type: string): number {
	return [...editor.getEditorState()._nodeMap.values()].filter(node => node.getType() === type)
		.length;
}

/** What a newcomer reads from the shared state, against what everybody live sees. */
async function consistent(...live: Person[]): Promise<string> {
	let fresh = follower(new Y.Doc());
	Y.applyUpdate(fresh.doc, Y.encodeStateAsUpdate(live[0]!.doc), REMOTE);
	await settle();
	let expected = source(fresh.editor);
	for (let each of live) expect(source(each.editor)).toBe(expected);
	return expected;
}

/** Append to the nth paragraph, as typing would. */
function type(editor: LexicalEditor, value: string, index = 0) {
	editor.update(() => {
		let paragraph = $getRoot().getChildren().filter($isParagraphNode)[index];
		if (!paragraph) throw new Error("no paragraph to type into");
		paragraph.append($createTextNode(value));
	}, { discrete: true });
}

function undo(editor: LexicalEditor) {
	editor.dispatchCommand(UNDO_COMMAND, undefined);
}

function redo(editor: LexicalEditor) {
	editor.dispatchCommand(REDO_COMMAND, undefined);
}

const DECISION = {
	id: "01K0N4Y9VG9DHBFZB6HC89E2AA",
	quote: "Keep the pilot small.",
	by: "octocat",
	at: "2026-10-07T00:00:00.000Z",
	notes: [{ by: "octocat", text: "Keep it small." }],
};

const RESEARCH = "01K0N4Y9VG9DHBFZB6HC89E2AB";

const QUESTIONNAIRE = `<Questionnaire id="01K0N4TR8K7JGM4R1J7PW4R8YJ">\n`
	+ `<Question id="01K0N4V4E7Y6P4MJ5WD8XZF3B2" header="Rollout" `
	+ `prompt="How should we deploy?" multiple="false">\n`
	+ `<Option id="01K0N4W3B7P27CBAEC7A8C8WEA" label="Canary" />\n`
	+ `</Question>\n`
	+ `</Questionnaire>\n`;

const TABLE = "| a | b | c |\n| - | - | - |\n| d | e | f |\n| g | h | i |\n";

function appendTable(editor: LexicalEditor) {
	editor.update(() => {
		for (let node of $createPlanNodes(parse(TABLE) as never, { registry: REGISTRY })) {
			$getRoot().append(node);
		}
	}, { discrete: true });
}

describe("plan history", () => {
	it("undoes and redoes this person's typing", async () => {
		let { me, peer } = await room("Start here.\n");

		type(me.editor, " Mine.");
		await settle();
		expect(text(me.editor)).toBe("Start here. Mine.");

		undo(me.editor);
		await settle();
		expect(text(me.editor)).toBe("Start here.");

		redo(me.editor);
		await settle();
		expect(text(me.editor)).toBe("Start here. Mine.");
		await consistent(me, peer);
	});

	it("leaves a peer's edit alone", async () => {
		let { me, peer } = await room("Mine.\n\nTheirs.\n");

		type(me.editor, " Typed by me.");
		await settle();
		type(peer.editor, " Typed by them.", 1);
		await settle();

		undo(me.editor);
		await settle();
		expect(text(me.editor)).not.toContain("Typed by me.");
		expect(text(me.editor)).toContain("Typed by them.");
		await consistent(me, peer);
	});

	it("undoes typing around a projection the server inserted afterwards", async () => {
		let { me, peer, server } = await room("Start here.\n");

		me.editor.update(() => {
			$getRoot().append($createParagraphNode().append($createTextNode("A new paragraph.")));
		}, { discrete: true });
		await settle();
		server.editor.update(() => {
			$getRoot().append($createDecisionNode(DECISION));
		}, { discrete: true });
		await settle();

		undo(me.editor);
		await settle();
		expect(text(me.editor)).not.toContain("A new paragraph.");
		expect(count(me.editor, "plan-decision")).toBe(1);
		await consistent(me, peer, server);
	});

	it("will not undo past a projection this person inserted", async () => {
		let { me, peer } = await room("Start here.\n");

		me.editor.update(() => {
			$getRoot().getFirstChildOrThrow().insertAfter($createResearchNode(RESEARCH));
		}, { discrete: true });
		await settle();
		let before = Y.encodeStateVector(me.doc);

		undo(me.editor);
		await settle();
		expect(count(me.editor, "plan-research")).toBe(1);
		// Nothing was sent: a removed reference would be refused by the server.
		expect(Y.encodeStateVector(me.doc)).toEqual(before);

		// The refused step ends the history rather than blocking it forever.
		let inserted = text(me.editor);
		type(me.editor, " Later.");
		await settle();
		undo(me.editor);
		await settle();
		expect(text(me.editor)).toBe(inserted);
		expect(count(peer.editor, "plan-research")).toBe(1);
	});

	it("checks the step Yjs reaches past one that no longer changes anything", async () => {
		let { me, peer } = await room("Start here.\n\nSecond.\n", 2, 0);

		me.editor.update(() => {
			$getRoot().getFirstChildOrThrow().insertAfter($createResearchNode(RESEARCH));
		}, { discrete: true });
		await settle();
		type(me.editor, " x", 1);
		await settle();
		// The peer deletes exactly what I typed, so my last step is now empty.
		peer.editor.update(() => {
			$getRoot().getChildren().filter($isParagraphNode)[1]!.getLastChildOrThrow().remove();
		}, { discrete: true });
		await settle();

		undo(me.editor);
		await settle();
		expect(count(me.editor, "plan-research")).toBe(1);
		expect(count(peer.editor, "plan-research")).toBe(1);
		await consistent(me, peer);
	});

	it("does nothing while the editor is read-only", async () => {
		let { me } = await room("Start here.\n");
		type(me.editor, " Mine.");
		await settle();

		me.editor.setEditable(false);
		undo(me.editor);
		await settle();
		expect(text(me.editor)).toBe("Start here. Mine.");
	});
});

describe("plan history with peers", () => {
	it("refuses only the step a peer has built on, and keeps older ones", async () => {
		let { me, peer } = await room("Start here.\n", 2, 0);

		type(me.editor, " Earlier.");
		await settle();
		me.editor.update(() => {
			$getRoot().append($createParagraphNode().append($createTextNode("Mine.")));
		}, { discrete: true });
		await settle();
		type(peer.editor, " Theirs.", 1);
		await settle();

		undo(me.editor);
		await settle();
		expect(me.refusals).toEqual(["others"]);
		expect(text(me.editor)).toContain("Mine. Theirs.");

		undo(me.editor);
		await settle();
		expect(text(me.editor)).not.toContain("Earlier.");
		expect(text(me.editor)).toContain("Mine. Theirs.");
		await consistent(me, peer);
	});

	it("will not restore a card a peer has since moved again", async () => {
		let { me, peer, server } = await room("First.\n\nSecond.\n", 2, 0);
		server.editor.update(() => {
			$getRoot().append($createDecisionNode(DECISION));
		}, { discrete: true });
		await settle();

		let move = (editor: LexicalEditor, where: "start" | "end") =>
			editor.update(() => {
				// In Yjs a move is a removal and a fresh insertion of the same card.
				$getRoot().getChildren().find(node => node.getType() === "plan-decision")?.remove();
				let card = $createDecisionNode(DECISION);
				if (where === "start") $getRoot().getFirstChildOrThrow().insertBefore(card);
				else $getRoot().getChildren().find($isParagraphNode)!.insertAfter(card);
			}, { discrete: true });
		move(me.editor, "start");
		await settle();
		move(peer.editor, "end");
		await settle();
		expect(count(server.editor, "plan-decision")).toBe(1);

		undo(me.editor);
		await settle();
		expect(me.refusals).toEqual(["change"]);
		expect(count(server.editor, "plan-decision")).toBe(1);
		await consistent(me, peer, server);
	});

	it("will not delete a paragraph a peer has typed in", async () => {
		let { me, peer } = await room("Start here.\n");

		me.editor.update(() => {
			$getRoot().append($createParagraphNode().append($createTextNode("Mine.")));
		}, { discrete: true });
		await settle();
		type(peer.editor, " Theirs.", 1);
		await settle();

		undo(me.editor);
		await settle();
		expect(text(peer.editor)).toContain("Theirs.");
		expect(await consistent(me, peer)).toContain("Theirs.");
	});

	it("will not delete a table a peer has typed in", async () => {
		let { me, peer } = await room("Start here.\n");

		appendTable(me.editor);
		await settle();
		peer.editor.update(() => {
			let table = $getRoot().getChildren().find(node => node.getType() === "table");
			if (!$isElementNode(table)) throw new Error("no table");
			let row = table.getChildAtIndex(1);
			let cell = $isElementNode(row) ? row.getChildAtIndex(1) : null;
			let paragraph = $isElementNode(cell) ? cell.getFirstChild() : null;
			if (!$isElementNode(paragraph)) throw new Error("no cell paragraph");
			paragraph.append($createTextNode(" peer"));
		}, { discrete: true });
		await settle();

		undo(me.editor);
		await settle();
		expect(await consistent(me, peer)).toContain("e peer");
	});

	it("will not delete a list a peer has typed in", async () => {
		let { me, peer } = await room("Start here.\n");

		me.editor.update(() => {
			for (let node of $createPlanNodes(parse("- one\n- two\n") as never, { registry: REGISTRY })) {
				$getRoot().append(node);
			}
		}, { discrete: true });
		await settle();
		peer.editor.update(() => {
			let list = $getRoot().getLastChild();
			let item = $isElementNode(list) ? list.getFirstChild() : null;
			if (!$isElementNode(item)) throw new Error("no list item");
			item.append($createTextNode(" peer"));
		}, { discrete: true });
		await settle();

		undo(me.editor);
		await settle();
		expect(await consistent(me, peer)).toContain("one peer");
	});

	it("will not quickly remove a paragraph a peer has aligned", async () => {
		let { me, peer } = await room("Start here.\n", 2, 0);

		me.editor.update(() => {
			$getRoot().append($createParagraphNode().append($createTextNode("Mine.")));
		}, { discrete: true });
		await settle();
		peer.editor.update(() => {
			$getRoot().getChildren().filter($isParagraphNode)[1]!.setFormat("center");
		}, { discrete: true });
		await settle();

		let manager = (me as Person).history!.manager;
		expect(typing(manager.undoStack.at(-1)!, manager.doc)).toBe(false);
		undo(me.editor);
		await settle();
		expect(me.refusals).toEqual(["others"]);
		expect(text(peer.editor)).toContain("Mine.");
		await consistent(me, peer);
	});

	it("undoes a table nobody else has touched", async () => {
		let { me, peer } = await room("Start here.\n");

		appendTable(me.editor);
		await settle();
		undo(me.editor);
		await settle();
		expect(types(me.editor)).not.toContain("table");
		await consistent(me, peer);
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
		let last = () => me.binding.root.getSharedType().toDelta().at(-1)?.insert;
		let trailing = last();

		undo(me.editor);
		await settle();
		expect(text(me.editor)).not.toContain("Mine.");
		expect(types(me.editor)).toEqual(shape);
		// The same paragraph, not one removed by the undo and appended again.
		expect(last()).toBe(trailing);
	});

	it("keeps a keystroke that follows a remote change in the history", async () => {
		let { me, peer } = await room("Start here.\n\nTheirs.\n", 2, 0);

		type(peer.editor, " a", 1);
		// The next task, as a keystroke would be, ahead of any timer.
		await new Promise(resolve => setImmediate(resolve));
		type(me.editor, " Mine.");
		await settle();

		undo(me.editor);
		await settle();
		expect(text(me.editor)).not.toContain("Mine.");
		await consistent(me, peer);
	});
});

/** A small deterministic generator, so a failure can be replayed by its seed. */
function random(seed: number) {
	return () => {
		seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
		return seed / 2_147_483_648;
	};
}

function texts(editor: LexicalEditor): LexicalNode[] {
	return [...editor.getEditorState()._nodeMap.values()].filter(node =>
		$isTextNode(node) && node.isAttached()
	);
}

describe("plan history under random editing", () => {
	for (let seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
		it(`keeps the room openable and its projections intact (seed ${seed})`, async () => {
			let next = random(seed);
			let pick = <T>(items: T[]) => items[Math.floor(next() * items.length)]!;
			let { people, server } = await room(
				`Start here.\n\n${QUESTIONNAIRE}\nSecond.\n`,
				3,
				0,
			);
			let research = 0;
			let decisions = 0;
			let quick = 0;

			for (let round = 0; round < 60; round++) {
				let who = pick(people);
				let roll = next();
				if (roll < 0.25) {
					let paragraphs = who.editor.getEditorState().read(() =>
						$getRoot().getChildren().filter($isParagraphNode).length
					);
					if (paragraphs > 0) type(who.editor, ` w${round}`, Math.floor(next() * paragraphs));
				} else if (roll < 0.35) {
					who.editor.update(() => {
						$getRoot().append($createParagraphNode().append($createTextNode(`p${round}`)));
					}, { discrete: true });
				} else if (roll < 0.45) {
					who.editor.update(() => {
						let nodes = texts(who.editor);
						if (nodes.length > 1) pick(nodes).remove();
					}, { discrete: true });
				} else if (roll < 0.47) {
					appendTable(who.editor);
				} else if (roll < 0.5) {
					// Properties another client may set on someone else's prose.
					who.editor.update(() => {
						let blocks = $getRoot().getChildren().filter($isParagraphNode);
						let nodes = texts(who.editor);
						let choice = next();
						if (choice < 0.4 && blocks.length > 0) {
							pick(blocks).setFormat(pick(["center", "right", "left"]));
						} else if (choice < 0.7 && blocks.length > 0) {
							pick(blocks).setIndent(Math.floor(next() * 3));
						} else if (nodes.length > 0) (pick(nodes) as TextNode).toggleFormat("bold");
					}, { discrete: true });
				} else if (roll < 0.53) {
					let id = `01K0N4Y9VG9DHBFZB6HC89E${String(research++).padStart(3, "0")}`;
					who.editor.update(() => {
						$getRoot().getFirstChildOrThrow().insertAfter($createResearchNode(id));
					}, { discrete: true });
				} else if (roll < 0.56) {
					let id = `01K0N4Y9VG9DHBFZB6HC89F${String(decisions++).padStart(3, "0")}`;
					server.editor.update(() => {
						$getRoot().append($createDecisionNode({ ...DECISION, id }));
					}, { discrete: true });
				} else if (roll < 0.85) {
					// Whatever the quick check lets through, the full rehearsal accepts.
					let manager = who.history!.manager;
					let top = manager.undoStack.at(-1);
					if (top && typing(top, manager.doc)) {
						quick++;
						expect(rehearse(manager, "undo", false)).toEqual({ ok: true });
					}
					undo(who.editor);
				} else {
					redo(who.editor);
				}
				await settle();

				// The server never sees a projection disappear, so it never refuses a batch.
				expect(count(server.editor, "plan-research")).toBe(research);
				expect(count(server.editor, "plan-decision")).toBe(decisions);
				expect(count(server.editor, "plan-questionnaire")).toBe(1);
				await consistent(...people, server);
			}
			expect(quick).toBeGreaterThan(0);
		});
	}
});
