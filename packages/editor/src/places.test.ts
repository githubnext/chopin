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
import { $getRoot, $isElementNode, $isParagraphNode, $isTextNode } from "lexical";
import * as Y from "yjs";

import { importPlan, registry } from "@chopin/dialect";

import { clear, union, unpin } from "./marks";
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

/** Which one, when it matters which. */
function at(): string | undefined {
	return union()[0]?.anchorKey;
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
	it("leaves an accepted thread to its inline Decision surface", () => {
		let { binding, editor } = room();
		let subject = store(editor, binding);
		let value = thread();

		subject.sync([value]);
		subject.anchors([{
			thread: value.id,
			subject: rewritten(),
			result: { anchors: [anchor(editor, binding, 2)], pending: false },
		}]);

		// The inline Decision owns the accepted thread's mark, not comment chrome.
		expect(subject.snapshot().threads[0]?.places).toHaveLength(1);
		expect(marked()).toBe(0);

		subject.focus(value.id);
		expect(marked()).toBe(0);

		subject.focus(undefined);
		expect(marked()).toBe(0);
	});

	it("leaves every block a decision produced out of comment chrome", () => {
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

		expect(marked()).toBe(0);
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
		// Accepted threads have their inline Decision, not an orphan affordance
		// in the comment chrome.
		expect(view.orphaned).toBe(false);
		// Still readable: the conversation is the durable part of a comment.
		expect(view.thread.notes).toHaveLength(1);
	});
});

describe("an open thread whose phrase has drifted", () => {
	function open(editor: LexicalEditor, binding: Binding) {
		let subject = store(editor, binding);
		let value = thread({ status: "open", quote: undefined });
		subject.sync([value]);
		subject.anchors([{
			thread: value.id,
			subject: { ...rewritten(), blocks: [anchor(editor, binding, 1)], drifted: undefined },
			result: { anchors: [], pending: false },
		}]);
		return subject;
	}

	it("keeps a gutter target when the phrase changed but its block survived", () => {
		let { binding, editor } = room();
		let subject = open(editor, binding);
		let key = blocks(editor)[1]!.getKey();

		editor.update(() => {
			let block = $getRoot().getChildren()[1]!;
			if (!$isElementNode(block)) throw new Error("subject block is not an element");
			let text = block.getFirstChild();
			if (!$isTextNode(text)) throw new Error("subject block has no text");
			text.setTextContent(
				"The renderer caches tiles for 10 seconds.",
			);
		}, { discrete: true });
		// The server has rebased the changed phrase and declined to guess a new
		// one. The block anchor remains valid enough to place its gutter target.
		subject.anchors([{
			thread: "01K0N4TR8K7JGM4R1J7PW4R8YJ",
			subject: { ...rewritten(), blocks: [anchor(editor, binding, 1)], drifted: true },
			result: { anchors: [], pending: false },
		}]);
		subject.refresh();

		let view = subject.snapshot().threads[0]!;
		expect(view.places).toEqual([]);
		expect(view.targetKey).toBe(key);
		expect(view.drifted).toBe(true);
		expect(view.orphaned).toBe(false);
	});

	it("calls a thread orphaned only when every subject block is gone", () => {
		let { binding, editor } = room();
		let subject = open(editor, binding);
		let key = blocks(editor)[1]!.getKey();

		editor.update(() => {
			$getRoot().getChildren()[1]!.remove();
		}, { discrete: true });
		subject.refresh();

		let view = subject.snapshot().threads[0]!;
		expect(blocks(editor).map(block => block.getKey())).not.toContain(key);
		expect(view.targetKey).toBeUndefined();
		expect(view.orphaned).toBe(true);
	});

	it("keeps exact open comment passages marked", () => {
		let { binding, editor } = room();
		open(editor, binding);

		expect(marked()).toBe(1);
	});
});

/**
 * Asking to be taken to a thread's prose.
 *
 * The scroll itself is not here — that needs a viewport, and `scroll.ts` is the
 * whole of the part that has one. What is testable is everything that decides
 * where to send somebody, and the mark they find when they arrive.
 */
describe("going to what a thread points at", () => {
	/** Two blocks, which is what a revision that rewrote a section leaves. */
	function revised(subject: ThreadStore, editor: LexicalEditor, binding: Binding, id: string) {
		subject.anchors([{
			thread: id,
			subject: rewritten(),
			result: {
				anchors: [anchor(editor, binding, 1), anchor(editor, binding, 2)],
				pending: false,
			},
		}]);
	}

	it("marks where it sent the reader, and keeps it there", () => {
		let { binding, editor } = room();
		let subject = store(editor, binding);
		let value = thread();

		subject.sync([value]);
		revised(subject, editor, binding, value.id);

		subject.reveal(value.id);

		// One place, not both: arriving somewhere has to say which somewhere.
		expect(marked()).toBe(1);
		expect(at()).toBe(subject.snapshot().threads[0]!.places[0]!.anchorKey);
	});

	it("walks to the next place each time it is asked", () => {
		let { binding, editor } = room();
		let subject = store(editor, binding);
		let value = thread();

		subject.sync([value]);
		revised(subject, editor, binding, value.id);
		let places = subject.snapshot().threads[0]!.places;

		subject.reveal(value.id);
		expect(at()).toBe(places[0]!.anchorKey);

		subject.reveal(value.id);
		expect(at()).toBe(places[1]!.anchorKey);

		// Round, rather than stopping at the end with nothing to say why.
		subject.reveal(value.id);
		expect(at()).toBe(places[0]!.anchorKey);
	});

	/**
	 * The step belongs to the pin. A reader whose mark has gone has moved on,
	 * and starting them at the third block a minute later would be a jump with
	 * nothing on screen to explain it.
	 */
	it("starts again once the mark it left has gone", () => {
		let { binding, editor } = room();
		let subject = store(editor, binding);
		let value = thread();

		subject.sync([value]);
		revised(subject, editor, binding, value.id);
		let places = subject.snapshot().threads[0]!.places;

		subject.reveal(value.id);
		subject.reveal(value.id);
		expect(at()).toBe(places[1]!.anchorKey);

		unpin();

		subject.reveal(value.id);
		expect(at()).toBe(places[0]!.anchorKey);
	});

	it("lends the mark to whatever the reader points at next, then takes it back", () => {
		let { binding, editor } = room();
		let subject = store(editor, binding);
		let value = thread();

		subject.sync([value]);
		revised(subject, editor, binding, value.id);
		subject.reveal(value.id);

		// The comment hover cannot replace the inline Decision's mark.
		subject.focus(value.id);
		expect(marked()).toBe(1);

		// And leaving it goes back to the one block they were sent to.
		subject.focus(undefined);
		expect(marked()).toBe(1);
	});

	it("sends nobody anywhere when the thread has lost its place", () => {
		let { binding, editor } = room();
		let subject = store(editor, binding);
		let value = thread();

		subject.sync([value]);
		subject.anchors([{
			thread: value.id,
			subject: rewritten(),
			result: { anchors: [], pending: false },
		}]);

		subject.reveal(value.id);

		expect(marked()).toBe(0);
	});

	it("leaves nothing marked once the pane is gone", () => {
		let { binding, editor } = room();
		let subject = store(editor, binding);
		let value = thread();

		subject.sync([value]);
		revised(subject, editor, binding, value.id);
		subject.reveal(value.id);

		subject.release();

		expect(marked()).toBe(0);
	});
});
