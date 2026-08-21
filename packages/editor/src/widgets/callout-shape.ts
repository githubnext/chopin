/** Repairs the child shape written by the original callout slash command. */

import { $createParagraphNode, $nodesOfType, COLLABORATION_TAG, HISTORIC_TAG } from "lexical";
import { CalloutNode } from "@chopin/dialect";

import type { ElementNode, LexicalEditor } from "lexical";

function $normalizeCalloutChildren(callout: CalloutNode): void {
	let paragraph: ElementNode | undefined;
	for (let child of callout.getChildren()) {
		if (!child.isInline()) {
			paragraph = undefined;
			continue;
		}
		if (!paragraph) {
			paragraph = $createParagraphNode();
			child.insertBefore(paragraph);
		}
		paragraph.append(child);
	}
}

function $hasLegacyCallout(): boolean {
	return $nodesOfType(CalloutNode).some(callout =>
		callout.getChildren().some(child => child.isInline())
	);
}

function $normalizeCallouts(): void {
	for (let callout of $nodesOfType(CalloutNode)) $normalizeCalloutChildren(callout);
}

export function registerCalloutNormalization(editor: LexicalEditor): () => void {
	let unregisterTransform = editor.registerNodeTransform(CalloutNode, $normalizeCalloutChildren);
	let unregisterRemote = editor.registerUpdateListener(({ editorState, tags }) => {
		if (!tags.has(COLLABORATION_TAG) && !tags.has(HISTORIC_TAG)) return;
		// Lexical deliberately skips node transforms while applying Yjs updates.
		// Repair in a following ordinary update so it syncs back like any other edit.
		if (editorState.read($hasLegacyCallout)) {
			editor.update($normalizeCallouts, { discrete: true });
		}
	});
	// Registration happens before ordinary document loading, but this pass also
	// repairs a callout that was already open when the new client code arrived.
	editor.update($normalizeCallouts, { discrete: true });
	return () => {
		unregisterTransform();
		unregisterRemote();
	};
}
