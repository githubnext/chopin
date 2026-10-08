/**
 * Points that survive other people's edits.
 *
 * A Lexical point is a node key and an offset, which a remote insert earlier
 * in the same text quietly invalidates. A Yjs relative position names the
 * character itself, so it still finds the same place after the document has
 * moved around it.
 */

import { $getAnchorAndFocusForUserState } from "@lexical/yjs";
import { $createRangeSelection, $getNodeByKey, $isElementNode, $isTextNode } from "lexical";
import * as Y from "yjs";

import type { Binding } from "@lexical/yjs";
import type { PointType, RangeSelection } from "lexical";

/** A point as a collaborative position. Call inside a read. */
export function $relativePosition(
	binding: Binding,
	point: PointType,
): Y.RelativePosition | undefined {
	let node = point.getNode();
	let collab = binding.collabNodeMap.get(point.key);
	if (!collab) return;

	let shared = collab.getSharedType();
	let offset = point.offset;
	if ($isTextNode(node)) {
		let parent = node.getParent();
		let parentCollab = parent && binding.collabNodeMap.get(parent.getKey());
		let currentOffset = collab.getOffset();
		if (!parentCollab || currentOffset < 0) return;
		shared = parentCollab.getSharedType();
		offset = currentOffset + 1 + point.offset;
	} else if ($isElementNode(node) && point.type === "element") {
		offset = 0;
		for (let child of node.getChildren().slice(0, point.offset)) {
			offset += $isTextNode(child) ? child.getTextContentSize() + 1 : 1;
		}
	}
	return Y.createRelativePositionFromTypeIndex(shared, offset);
}

/** Two positions back as a selection here, or nothing if either is gone. Call inside a read. */
export function $resolveRange(
	binding: Binding,
	anchor: Y.RelativePosition,
	focus: Y.RelativePosition,
): RangeSelection | undefined {
	let resolved;
	try {
		resolved = $getAnchorAndFocusForUserState(binding, {
			anchorPos: anchor,
			focusPos: focus,
			color: "",
			focusing: false,
			name: "",
			awarenessData: {},
		});
	} catch {
		return;
	}
	let { anchorKey, anchorOffset, focusKey, focusOffset } = resolved;
	if (!anchorKey || !focusKey) return;
	let anchorNode = $getNodeByKey(anchorKey);
	let focusNode = $getNodeByKey(focusKey);
	if (!anchorNode || !focusNode) return;
	let selection = $createRangeSelection();
	selection.anchor.set(anchorKey, anchorOffset, $isElementNode(anchorNode) ? "element" : "text");
	selection.focus.set(focusKey, focusOffset, $isElementNode(focusNode) ? "element" : "text");
	return selection;
}
