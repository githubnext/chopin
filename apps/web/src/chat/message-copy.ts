/** What copying a Chat message writes to the clipboard. */

import { fromMarkdown } from "mdast-util-from-markdown";

import { orderedRunsRemarkPlugin } from "./ordered-runs";
import { referenceRemarkPlugin } from "./reference-markdown";
import { referenceRenderModel } from "./references";

import type { Chat } from "@chopin/protocol";
import type { MarkdownNode } from "./reference-markdown";

type Node = MarkdownNode & {
	ordered?: boolean;
	start?: number;
	depth?: number;
};

let BLOCKS = new Set(["paragraph", "heading", "code", "blockquote", "list"]);

function inline(node: Node): string {
	switch (node.type) {
		case "text":
			return (node.value ?? "").replace(/[^\S\n]*\n[^\S\n]*/g, " ");
		case "inlineCode":
			return node.value ?? "";
		case "break":
			return "\n";
		case "html":
		case "image":
		case "imageReference":
		case "definition":
			return "";
		default:
			return (node.children ?? []).map(inline).join("");
	}
}

function block(node: Node, indent: string): string {
	if (node.type === "list") {
		let number = node.start ?? 1;
		return (node.children ?? []).map(item => {
			let marker = node.ordered ? `${number++}. ` : "- ";
			let parts = (item.children ?? []).filter(child => BLOCKS.has(child.type));
			let [first, ...rest] = parts.map(child => block(child, indent + "  "));
			return [`${indent}${marker}${(first ?? "").trimStart()}`, ...rest].join("\n");
		}).join("\n");
	}
	if (node.type === "blockquote") {
		return (node.children ?? []).filter(child => BLOCKS.has(child.type))
			.map(child => block(child, indent)).join("\n\n");
	}
	if (node.type === "code") return node.value ?? "";
	return inline(node).trim();
}

/**
 * The words the page shows for a message, one paragraph per blank line and one list item per line.
 * `lead` is what the page draws before the text, such as the Planner address of a message sent to it.
 */
export function plainTextOf(
	source: string,
	references?: Chat.Reference[],
	lead?: string,
): string {
	let model = referenceRenderModel(source, references);
	let tree = fromMarkdown(model.source) as unknown as Node;
	referenceRemarkPlugin(model)(tree);
	orderedRunsRemarkPlugin()(tree, { value: model.source });
	let body = (tree.children ?? []).filter(child => BLOCKS.has(child.type))
		.map(child => block(child, "")).filter(text => text !== "").join("\n\n");
	return [lead, body].filter(Boolean).join(" ");
}
