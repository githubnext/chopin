import { fromMarkdown } from "mdast-util-from-markdown";

import { orderedRunsRemarkPlugin } from "./ordered-runs";
import { referenceRemarkPlugin } from "./reference-markdown";
import { referenceRenderModel } from "./references";

import type { Chat } from "@chopin/protocol";
import type { MarkdownNode } from "./reference-markdown";

type Node = MarkdownNode;

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

function block(node: Node): string {
	if (node.type === "list") {
		return (node.children ?? []).map(item =>
			(item.children ?? []).filter(child => BLOCKS.has(child.type)).map(block).join("\n")
		).join("\n");
	}
	if (node.type === "blockquote") {
		return (node.children ?? []).filter(child => BLOCKS.has(child.type)).map(block).join("\n\n");
	}
	if (node.type === "code") return node.value ?? "";
	return inline(node).trim();
}

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
		.map(block).filter(text => text !== "").join("\n\n");
	return [lead, body].filter(Boolean).join(" ");
}
