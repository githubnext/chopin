/**
 * Where an accepted thread points once the agent has acted.
 *
 * The prose a thread was about is usually the prose it asked to have
 * rewritten, so after the turn the subject is gone by design. Treating that as
 * the thread having lost its place gets it backwards: what was discussed is
 * kept as a frozen quote, and what the decision produced is where it now
 * lives.
 *
 * Real Lexical and real Yjs, because the whole question is whether positions
 * resolve. Painting is still not tested — that needs layout, and happy-dom
 * returns zero for every measurement.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { createHeadlessEditor } from "@lexical/headless";
import { createYjsBinding, syncLexicalUpdateToYjs } from "@lexical/yjs";
import { $getRoot, $isParagraphNode } from "lexical";
import * as Y from "yjs";

import { importPlan, registry } from "@chopin/dialect";

import { clear, union } from "./marks";
import { ThreadStore } from "./threads";

import type { Binding, Provider } from "@lexical/yjs";
import type { LexicalEditor, LexicalNode } from "lexical";
import type { Comment, Plan } from "@chopin/protocol";

const REGISTRY = registry();

/*
 * A headless editor refuses `getElementByKey`, so painting cannot work here and
 * says so on every refresh. That it says so rather than throwing is the guard
 * doing its job; these tests are about where a thread points, not what that
 * looks like, so the complaint is quietened rather than worked around.
 */
let complain = console.error;
beforeAll(() => {
	console.error = () => {};
});
afterAll(() => {
	console.error = complain;
});

// The highlight registry is document-wide, so it outlives a single store.
afterEach(() => {
	clear();
});

const SOURCE = `# Title

The renderer caches tiles for 60 seconds.

The second paragraph.
`;

const QUOTE = "caches tiles for 60 seconds";

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

function room(): { editor: LexicalEditor; binding: Binding } {
	let editor = createHeadlessEditor({
		nodes: REGISTRY.nodes,
		onError(err) {
			throw err;
		},
	});

	let doc = new Y.Doc();
	let binding = createYjsBinding({ editor, id: "plan", doc, docMap: new Map([["plan", doc]]) });

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

/**
 * An anchor on the block at `index`, minted the way the server mints one.
 *
 * Index 0 of the block's own shared type: the position is the block's
 * collaborative identity, not a place inside it.
 */
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

/** A subject that cannot be resolved, which is what the agent leaves behind. */
function rewritten(): Plan.Passage {
	return {
		blocks: [{ epoch: "e1", position: "", digest: "sha256:gone", orphaned: true }],
		start: "",
		end: "",
		quote: QUOTE,
		offset: 0,
		length: QUOTE.length,
		drifted: true,
	};
}

function thread(over: Partial<Comment.Thread> = {}): Comment.Thread {
	return {
		id: "01K0N4TR8K7JGM4R1J7PW4R8YJ",
		status: "accepted",
		notes: [{ id: "n1", handle: "ana", text: "Too long.", ts: 1 }],
		quote: QUOTE,
		resolver: "kris",
		at: 2,
		...over,
	};
}

function store(editor: LexicalEditor, binding: Binding): ThreadStore {
	let subject = new ThreadStore();
	subject.attach(editor);
	subject.bind(binding);
	return subject;
}

/** How many passages the sidecar is currently asking to have marked. */
function marked(): number {
	return union().length;
}

describe("an accepted thread after the agent has acted", () => {
	it("points at the prose the decision produced", () => {
		let { binding, editor } = room();
		let subject = store(editor, binding);
		let value = thread();

		subject.sync([value]);
		subject.anchors([{
			thread: value.id,
			subject: rewritten(),
			result: { anchors: [anchor(editor, binding, 2)], pending: false },
		}]);

		let view = subject.snapshot().threads[0]!;
		expect(view.places).toHaveLength(1);
		// Its own text is gone, and it has not lost its place: it moved to what
		// accepting it caused to be written.
		expect(view.drifted).toBe(false);
		expect(view.quote).toBe(QUOTE);
	});

	it("points at every block the revision produced", () => {
		let { binding, editor } = room();
		let subject = store(editor, binding);
		let value = thread();

		subject.sync([value]);
		subject.anchors([{
			thread: value.id,
			subject: rewritten(),
			result: {
				anchors: [anchor(editor, binding, 1), anchor(editor, binding, 2)],
				pending: false,
			},
		}]);

		expect(subject.snapshot().threads[0]?.places).toHaveLength(2);
	});

	/**
	 * Pending means nobody has checked this since the plan moved, so it is not
	 * somewhere worth sending a reader — and the subject is gone, so there is
	 * nowhere else either.
	 */
	it("points nowhere while the result is waiting to be reviewed", () => {
		let { binding, editor } = room();
		let subject = store(editor, binding);
		let value = thread();

		subject.sync([value]);
		subject.anchors([{
			thread: value.id,
			subject: rewritten(),
			result: {
				anchors: [anchor(editor, binding, 2)],
				pending: true,
				reason: "plan_changed",
			},
		}]);

		let view = subject.snapshot().threads[0]!;
		expect(view.places).toHaveLength(0);
		expect(view.drifted).toBe(true);
		expect(view.applied).toBe(false);
	});

	/** Before the agent runs there is no result, and the phrase is still there. */
	it("points at the phrase until there is a result to point at instead", () => {
		let { binding, editor } = room();
		let subject = store(editor, binding);
		let value = thread({ status: "open", quote: undefined });

		subject.sync([value]);
		subject.anchors([{
			thread: value.id,
			// Not rewritten: the block is still the one the comment marked.
			subject: { ...rewritten(), blocks: [anchor(editor, binding, 1)], drifted: undefined },
			result: { anchors: [], pending: false },
		}]);

		let view = subject.snapshot().threads[0]!;
		expect(view.places).toHaveLength(1);
		expect(view.drifted).toBe(false);
	});

	/**
	 * Nothing is painted at rest. A plan accumulates decisions, so a standing
	 * mark ends up covering most of the document — which tells a reader
	 * nothing. Where a thread points is still known; it is only drawn when
	 * somebody asks by pointing at the card.
	 */
	it("marks nothing until the reader points at its card", () => {
		let { binding, editor } = room();
		let subject = store(editor, binding);
		let value = thread();

		subject.sync([value]);
		subject.anchors([{
			thread: value.id,
			subject: rewritten(),
			result: { anchors: [anchor(editor, binding, 2)], pending: false },
		}]);

		// It knows where it is either way.
		expect(subject.snapshot().threads[0]?.places).toHaveLength(1);
		expect(marked()).toBe(0);

		subject.focus(value.id);
		expect(marked()).toBe(1);

		subject.focus(undefined);
		expect(marked()).toBe(0);
	});

	it("marks every block a decision produced, not just the first", () => {
		let { binding, editor } = room();
		let subject = store(editor, binding);
		let value = thread();

		subject.sync([value]);
		subject.anchors([{
			thread: value.id,
			subject: rewritten(),
			result: {
				anchors: [anchor(editor, binding, 1), anchor(editor, binding, 2)],
				pending: false,
			},
		}]);
		subject.focus(value.id);

		expect(marked()).toBe(2);
	});

	it("points nowhere when neither end resolves", () => {
		let { binding, editor } = room();
		let subject = store(editor, binding);
		let value = thread();

		subject.sync([value]);
		subject.anchors([{
			thread: value.id,
			subject: rewritten(),
			result: { anchors: [], pending: false },
		}]);

		let view = subject.snapshot().threads[0]!;
		expect(view.places).toHaveLength(0);
		expect(view.drifted).toBe(true);
		// Still readable: the conversation is the durable part of a comment.
		expect(view.thread.notes).toHaveLength(1);
	});
});
