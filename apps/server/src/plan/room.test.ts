/**
 * The authoritative document, without a socket in sight.
 *
 * These exercise the parts a wire test cannot reach cleanly: what happens to a
 * document when two people edit the same region concurrently, and what happens
 * when an update leaves it in a state the dialect will not accept.
 */

import { describe, expect, it } from "bun:test";
import { createHeadlessEditor } from "@lexical/headless";
import { createYjsBinding, syncLexicalUpdateToYjs, syncYjsChangesToLexical } from "@lexical/yjs";
import { $getRoot, $isElementNode } from "lexical";
import * as Y from "yjs";

import { $importPlan, registry } from "@chopin/dialect";

import * as room from "./room";

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

/** A client: its own editor and Y.Doc, exactly as a browser would have. */
function peer(): { editor: LexicalEditor; doc: Y.Doc; binding: Binding } {
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

	binding.root.getSharedType().observeDeep((events, transaction) => {
		if (transaction.origin !== binding) syncYjsChangesToLexical(binding, PROVIDER, events, false);
	});

	return { editor, doc, binding };
}

describe("document", () => {
	it("starts empty and projects to nothing", async () => {
		let document = await room.create();
		expect(room.project(document)).toBe("");
	});

	it("seeds from canonical source and projects it back unchanged", async () => {
		let source = "# Title\n\nA paragraph.\n";
		let document = await room.create(source);
		expect(room.project(document)).toBe(source);
	});

	it("refuses to seed from source the dialect rejects", async () => {
		await expect(room.create("<script>alert(1)</script>\n")).rejects.toThrow();
	});

	it("gives a joining client only what it is missing", async () => {
		let document = await room.create("# Title\n");
		let whole = room.sync(document);
		let caughtUp = room.sync(document, Y.encodeStateVector(document.doc));

		expect(whole.byteLength).toBeGreaterThan(0);
		expect(caughtUp.byteLength).toBeLessThan(whole.byteLength);
	});
});

describe("concurrent editing", () => {
	/**
	 * The property the whole design rests on: two people editing different
	 * parts of one document end up with the same document, whatever order the
	 * updates arrive in.
	 */
	it("converges when two peers edit different tabs", async () => {
		let source = `<Tabs id="01K0N4TR8K7JGM4R1J7PW4R8YJ">
	<Tab id="01K0N4V4E7Y6P4MJ5WD8XZF3B2" label="One">
		First.
	</Tab>
	<Tab id="01K0N4W3B7P27CBAEC7A8C8WEA" label="Two">
		Second.
	</Tab>
</Tabs>
`;
		let server = await room.create(source);
		let state = room.sync(server);

		let alice = peer();
		let bob = peer();
		Y.applyUpdate(alice.doc, state, "remote");
		Y.applyUpdate(bob.doc, state, "remote");
		await room.settle();

		// Each edits a different tab, neither having seen the other's change.
		let before = { alice: Y.encodeStateVector(alice.doc), bob: Y.encodeStateVector(bob.doc) };

		alice.editor.update(() => {
			let tab = $getRoot().getFirstChild();
			let first = $isElementNode(tab) ? tab.getFirstChild() : null;
			if ($isElementNode(first)) first.getFirstChild()?.remove();
		}, { discrete: true });

		bob.editor.update(() => {
			let tabs = $getRoot().getFirstChild();
			let second = $isElementNode(tabs) ? tabs.getLastChild() : null;
			if ($isElementNode(second)) second.getFirstChild()?.remove();
		}, { discrete: true });

		let fromAlice = Y.encodeStateAsUpdate(alice.doc, before.alice);
		let fromBob = Y.encodeStateAsUpdate(bob.doc, before.bob);

		// The server sees them in one order, each peer in the other.
		await room.apply(server, [fromAlice, fromBob]);
		Y.applyUpdate(alice.doc, fromBob, "remote");
		Y.applyUpdate(bob.doc, fromAlice, "remote");
		await room.settle();

		let projected = room.project(server);
		expect(Y.encodeStateAsUpdate(alice.doc).byteLength)
			.toBe(Y.encodeStateAsUpdate(bob.doc).byteLength);
		expect(projected).not.toContain("First.");
		expect(projected).not.toContain("Second.");
	});

	it("survives the same update arriving twice", async () => {
		let server = await room.create("# Title\n");
		let client = peer();
		Y.applyUpdate(client.doc, room.sync(server), "remote");
		await room.settle();

		let before = Y.encodeStateVector(client.doc);
		client.editor.update(() => {
			$importPlan("# Title\n\nAdded.\n", { registry: REGISTRY, validate: false });
		}, { discrete: true });
		let update = Y.encodeStateAsUpdate(client.doc, before);

		await room.apply(server, [update]);
		let once = room.project(server);
		await room.apply(server, [update]);

		expect(room.project(server)).toBe(once);
	});
});

describe("recovery", () => {
	/**
	 * A rejected batch cannot be undone — Yjs has no such operation — so the
	 * document is rebuilt from the last state that was known to be good.
	 */
	it("reports an update that leaves the document invalid", async () => {
		let document = await room.create("# Title\n");
		room.mark(document);

		let client = peer();
		Y.applyUpdate(client.doc, room.sync(document), "remote");
		await room.settle();

		// A Callout with no id is well-formed MDX and outside the dialect.
		let before = Y.encodeStateVector(client.doc);
		client.editor.update(() => {
			$importPlan('<Callout type="note">\n\tText.\n</Callout>\n', {
				registry: REGISTRY,
				validate: false,
			});
		}, { discrete: true });

		let outcome = await room.apply(document, [Y.encodeStateAsUpdate(client.doc, before)]);
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.issues.length).toBeGreaterThan(0);
	});

	it("rebuilds to the last known-good state under a fresh epoch", async () => {
		let document = await room.create("# Title\n");
		room.mark(document);
		let original = document.epoch;

		let client = peer();
		Y.applyUpdate(client.doc, room.sync(document), "remote");
		await room.settle();
		let before = Y.encodeStateVector(client.doc);
		client.editor.update(() => {
			$importPlan('<Callout type="note">\n\tText.\n</Callout>\n', {
				registry: REGISTRY,
				validate: false,
			});
		}, { discrete: true });
		await room.apply(document, [Y.encodeStateAsUpdate(client.doc, before)]);

		let rebuilt = await room.rebuild(document);
		expect(rebuilt.epoch).not.toBe(original);
		expect(room.project(rebuilt)).toBe("# Title\n");
	});
});

describe("round trip proof", () => {
	it("accepts source that survives import and export", () => {
		expect(() => room.validate("# Title\n\nText with **bold**.\n")).not.toThrow();
	});

	it("rejects source the dialect does not allow", () => {
		expect(() => room.validate('<Unknown id="x" />\n')).toThrow();
	});
});
