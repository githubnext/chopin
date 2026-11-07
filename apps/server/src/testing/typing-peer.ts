import { $getRoot, $isElementNode, $isTextNode } from "lexical";
import * as Y from "yjs";

import { peer } from "./peer";

export { Y };

/** The origin of what the server sent, which is not the peer's own to send back. */
const REMOTE = "remote";

export type TypingPeer = {
	doc: Y.Doc;
	/** Takes what the server sent: its whole state on a first open, the difference on a later one. */
	receive(update: Uint8Array): Promise<void>;
	/** Appends ` token` to the paragraph that starts with `marker`. */
	type(marker: string, token: string): void;
	/** The text of the paragraph that starts with `marker`. */
	text(marker: string): string | undefined;
	/** Called with each update the peer's own edits make, as a browser's provider is. */
	onLocal(callback: (update: Uint8Array) => void): void;
	destroy(): void;
};

/**
 * A client with no page: the editor and Y.Doc a browser would have (`peer`), for a load run that
 * types into one paragraph of a document, as a person does, and hands each update to its wire.
 */
export function typingPeer(): TypingPeer {
	let client = peer();
	let flush = () => client.editor.update(() => {}, { discrete: true });
	let paragraph = (marker: string) => {
		for (let node of $getRoot().getChildren()) {
			if (!$isElementNode(node)) continue;
			let first = node.getFirstChild();
			if ($isTextNode(first) && first.getTextContent().split(/\s+/)[0] === marker) return first;
		}
		return undefined;
	};
	return {
		doc: client.doc,
		async receive(update) {
			Y.applyUpdate(client.doc, update, REMOTE);
			await Promise.resolve();
			flush();
		},
		type(marker, token) {
			client.editor.update(() => {
				let text = paragraph(marker);
				if (!text) throw new Error(`no paragraph starts with ${marker}`);
				text.setTextContent(`${text.getTextContent()} ${token}`);
			}, { discrete: true });
		},
		text(marker) {
			return client.editor.getEditorState().read(() => paragraph(marker)?.getTextContent());
		},
		onLocal(callback) {
			client.doc.on("update", (update: Uint8Array, origin: unknown) => {
				if (origin !== REMOTE) callback(update);
			});
		},
		destroy() {
			client.doc.destroy();
		},
	};
}
