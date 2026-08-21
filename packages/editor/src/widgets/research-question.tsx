import { useEffect, useRef } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
	$getSelection,
	$isElementNode,
	$nodesOfType,
	COMMAND_PRIORITY_HIGH,
	COPY_COMMAND,
	CUT_COMMAND,
	DRAGSTART_COMMAND,
	SELECTION_INSERT_CLIPBOARD_NODES_COMMAND,
} from "lexical";
import { ResearchQuestionNode, ULID, ulid } from "@chopin/dialect";

import type { LexicalNode } from "lexical";

/** Preserve an explicit move; every ordinary paste creates document-local identity. */
export function normalizeResearchQuestionIds(
	nodes: LexicalNode[],
	preserve: Set<string> = new Set(),
): void {
	let used = new Set($nodesOfType(ResearchQuestionNode).map(node => node.getId()));
	let visit = (node: LexicalNode): void => {
		if (node instanceof ResearchQuestionNode) {
			let id = node.getId();
			let moving = preserve.delete(id) && !used.has(id);
			if (!ULID.test(id) || used.has(id) || !moving) {
				id = ulid();
				node.setId(id);
			}
			used.add(id);
		}
		if ($isElementNode(node)) {
			for (let child of node.getChildren()) visit(child);
		}
	};
	for (let node of nodes) visit(node);
}

function selectedResearchIds(): Set<string> {
	let ids = new Set<string>();
	let selection = $getSelection();
	for (let selected of selection?.getNodes() ?? []) {
		let node: LexicalNode | null = selected;
		while (node) {
			if (node instanceof ResearchQuestionNode) ids.add(node.getId());
			node = node.getParent();
		}
	}
	return ids;
}

export function ResearchQuestionPlugin() {
	let [editor] = useLexicalComposerContext();
	let moving = useRef(new Set<string>());
	useEffect(() => {
		let copy = editor.registerCommand(
			COPY_COMMAND,
			() => {
				moving.current.clear();
				return false;
			},
			COMMAND_PRIORITY_HIGH,
		);
		let cut = editor.registerCommand(
			CUT_COMMAND,
			() => {
				moving.current = selectedResearchIds();
				return false;
			},
			COMMAND_PRIORITY_HIGH,
		);
		let drag = editor.registerCommand(
			DRAGSTART_COMMAND,
			() => {
				moving.current = selectedResearchIds();
				return false;
			},
			COMMAND_PRIORITY_HIGH,
		);
		let insert = editor.registerCommand(
			SELECTION_INSERT_CLIPBOARD_NODES_COMMAND,
			payload => {
				normalizeResearchQuestionIds(payload.nodes, moving.current);
				moving.current.clear();
				return false;
			},
			COMMAND_PRIORITY_HIGH,
		);
		return () => {
			copy();
			cut();
			drag();
			insert();
		};
	}, [editor]);
	return null;
}
