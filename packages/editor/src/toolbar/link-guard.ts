/**
 * Links that arrive by paste or any other local route, checked as they land.
 *
 * The link editor checks what a person types, but a paste brings `<a href>`
 * straight from another page: a protocol-relative CDN address or a URL with a
 * zero-width character inside it. Either would sync, be refused by the server,
 * and cost the whole room a rebuild. So a new local link whose address fails
 * the same check is unwrapped to its text before the batch ever leaves.
 *
 * Only links new in this update and made here: one arriving from a
 * collaborator or from history is the server's to judge, and a stored link
 * from before the newer rules must not be silently stripped on every open.
 */

import { $isLinkNode, LinkNode } from "@lexical/link";
import { LINK_PROTOCOLS } from "@chopin/dialect";
import { $getEditor, $hasUpdateTag, COLLABORATION_TAG, HISTORIC_TAG } from "lexical";

import { checkUrl } from "./url";

import type { LexicalEditor } from "lexical";

const RULES = { protocols: LINK_PROTOCOLS, relative: true };

/** Unwrap or normalise one link. Call inside an update. */
export function $guardLink(node: LinkNode): void {
	if ($hasUpdateTag(COLLABORATION_TAG) || $hasUpdateTag(HISTORIC_TAG)) return;
	if ($getEditor().getEditorState()._nodeMap.has(node.getKey())) return;
	let url = node.getURL();
	let checked = checkUrl(url, RULES);
	if (checked.url === undefined) {
		for (let child of node.getChildren()) node.insertBefore(child);
		node.remove();
	} else if (checked.url !== url) {
		node.setURL(checked.url);
	}
}

export function registerLinkGuard(editor: LexicalEditor): () => void {
	return editor.registerNodeTransform(LinkNode, node => {
		if ($isLinkNode(node)) $guardLink(node);
	});
}
