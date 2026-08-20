/** Repairs the child shape written by the original callout slash command. */

import { $createParagraphNode, $nodesOfType } from "lexical";
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

export function registerCalloutNormalization(editor: LexicalEditor): () => void {
	let unregister = editor.registerNodeTransform(CalloutNode, $normalizeCalloutChildren);
	// Registration happens before ordinary document loading, but this pass also
	// repairs a callout that was already open when the new client code arrived.
	editor.update(
		() => {
			for (let callout of $nodesOfType(CalloutNode)) $normalizeCalloutChildren(callout);
		},
		{ discrete: true },
	);
	return unregister;
}
