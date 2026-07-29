/**
 * Resolving where a decision lives against this editor's tree.
 *
 * A Lexical key is per-editor, so the server can only say which blocks it means
 * as Yjs relative positions and every client works out its own keys. That is
 * the whole of what `relate` does, and it had no test — which is how a two-part
 * relationship nobody could tell apart survived as long as it did.
 *
 * Real Lexical and real Yjs, because the question is whether positions resolve.
 * What the resolved keys are then used for needs a browser and is not here.
 */

import { describe, expect, it } from "bun:test";
import { createHeadlessEditor } from "@lexical/headless";
import { createYjsBinding, syncLexicalUpdateToYjs } from "@lexical/yjs";
import { $getRoot, $isParagraphNode } from "lexical";
import * as Y from "yjs";

import { importPlan, registry } from "@chopin/dialect";

import { counts, relate, resolve } from "./anchors";

import type { Binding, Provider } from "@lexical/yjs";
import type { LexicalEditor, LexicalNode } from "lexical";
import type { Plan } from "@chopin/protocol";

const REGISTRY = registry();

/** Awareness is never read here, so a no-op provider suffices. */
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

const SOURCE = `# Title

The renderer caches tiles for 60 seconds.

The second paragraph.
`;

function room(): { editor: LexicalEditor; binding: Binding } {
	let editor = createHeadlessEditor({
		nodes: REGISTRY.nodes,
		onError(err) {
			throw err;
		},
	});

	let doc = new Y.Doc();
	let binding = createYjsBinding({ editor, id: "plan", doc, docMap: new Map([["plan", doc]]) });

	// A block has no collaborative identity until the tree has been synced, and
	// an anchor is that identity — so without this there is nothing to anchor.
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

	importPlan(editor, SOURCE, { registry: REGISTRY });
	return { editor, binding };
}

/** The blocks the source addresses, the way both ends count them. */
function blocks(editor: LexicalEditor): LexicalNode[] {
	let found: LexicalNode[] = [];
	editor.getEditorState().read(() => {
		found = $getRoot().getChildren().filter(
			node => !($isParagraphNode(node) && node.getChildrenSize() === 0),
		);
	});
	return found;
}

function encode(value: Uint8Array): string {
	let binary = "";
	for (let byte of value) binary += String.fromCharCode(byte);
	return btoa(binary);
}

/** An anchor on the block at `index`, minted the way the server mints one. */
function anchor(editor: LexicalEditor, binding: Binding, index: number): Plan.Anchor {
	let key = blocks(editor)[index]!.getKey();
	let type = binding.collabNodeMap.get(key)?.getSharedType();
	if (!type) throw new Error(`block ${index} has no collaborative identity`);

	return {
		epoch: "e1",
		position: encode(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(type, 0, -1))),
		digest: `sha256:${index}`,
	};
}

function widget(questions: { [id: string]: Plan.AnchorSet }): Plan.WidgetAnchors {
	return { widget: "w1", questions };
}

describe("where a questionnaire's decisions live", () => {
	it("resolves each one to the blocks it names in this editor", () => {
		let { binding, editor } = room();

		let found = relate(binding, [widget({
			q1: { anchors: [anchor(editor, binding, 1), anchor(editor, binding, 2)], pending: false },
		})]);

		expect(found).toHaveLength(1);
		expect(found[0]?.keys).toEqual([
			blocks(editor)[1]!.getKey(),
			blocks(editor)[2]!.getKey(),
		]);
	});

	/** One entry per question. It used to be two, and they led to the same prose. */
	it("gives a question one placement, not one per kind of relationship", () => {
		let { binding, editor } = room();

		let found = relate(binding, [widget({
			q1: { anchors: [anchor(editor, binding, 1)], pending: false },
			q2: { anchors: [anchor(editor, binding, 2)], pending: false },
		})]);

		expect(found.map(item => item.question)).toEqual(["q1", "q2"]);
	});

	it("drops an anchor whose block this document no longer has", () => {
		let { binding } = room();

		let found = relate(binding, [widget({
			q1: {
				anchors: [{ epoch: "e1", position: "", digest: "sha256:gone", orphaned: true }],
				pending: false,
			},
		})]);

		expect(found[0]?.keys).toEqual([]);
	});

	/** A position from a history this document does not hold, not a crash. */
	it("survives an anchor it cannot decode", () => {
		let { binding } = room();

		expect(() =>
			relate(binding, [widget({
				q1: { anchors: [{ epoch: "e0", position: "!!!", digest: "sha256:x" }], pending: false },
			})])
		).not.toThrow();
	});

	it("resolves nothing from an anchor marked orphaned without trying", () => {
		let { binding } = room();
		let gone: Plan.Anchor = { epoch: "e1", position: "", digest: "sha256:x", orphaned: true };

		expect(resolve(binding, gone)).toBeUndefined();
	});
});

describe("how much prose a card says it points at", () => {
	it("counts the blocks each decision resolves to", () => {
		let { binding, editor } = room();
		let found = relate(binding, [widget({
			q1: { anchors: [anchor(editor, binding, 1), anchor(editor, binding, 2)], pending: false },
		})]);

		expect(counts(found, "w1")).toEqual({ q1: 2 });
	});

	/**
	 * Pending means nobody has checked since the plan moved. Counting it as
	 * nowhere is what keeps the text inert rather than offering a jump that
	 * may land somewhere stale.
	 */
	it("counts an unreviewed decision as nowhere, however many blocks it names", () => {
		let { binding, editor } = room();
		let found = relate(binding, [widget({
			q1: { anchors: [anchor(editor, binding, 1)], pending: true, reason: "plan_changed" },
		})]);

		expect(counts(found, "w1")).toEqual({ q1: 0 });
	});

	it("reports only the questionnaire that was asked about", () => {
		let { binding, editor } = room();
		let found = [
			...relate(binding, [
				widget({ q1: { anchors: [anchor(editor, binding, 1)], pending: false } }),
			]),
			...relate(binding, [{
				widget: "w2",
				questions: { q9: { anchors: [anchor(editor, binding, 2)], pending: false } },
			}]),
		];

		expect(counts(found, "w1")).toEqual({ q1: 1 });
	});
});
