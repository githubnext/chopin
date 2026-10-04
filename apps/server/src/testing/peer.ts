import { createHeadlessEditor } from "@lexical/headless";
import { createYjsBinding, syncLexicalUpdateToYjs, syncYjsChangesToLexical } from "@lexical/yjs";
import * as Y from "yjs";

import { registry } from "@chopin/dialect";

import type { Binding, Provider } from "@lexical/yjs";
import type { LexicalEditor } from "lexical";

export const REGISTRY = registry();

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
export function peer(): { editor: LexicalEditor; doc: Y.Doc; binding: Binding } {
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
