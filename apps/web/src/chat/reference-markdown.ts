import type { Chat } from "@chopin/protocol";
import type { ReferenceRenderModel } from "./references";

type MarkdownPosition = {
	start: { offset?: number };
	end: { offset?: number };
};

export type MarkdownNode = {
	type: string;
	value?: string;
	url?: string;
	children?: MarkdownNode[];
	position?: MarkdownPosition;
	data?: { hProperties?: Record<string, unknown> };
};

let BLOCKED = new Set([
	"code",
	"definition",
	"image",
	"imageReference",
	"inlineCode",
	"link",
	"linkReference",
]);

function text(value: string): MarkdownNode {
	return { type: "text", value };
}

function referenceNode(reference: Chat.Reference, index: number): MarkdownNode {
	return {
		type: "link",
		url: reference.href,
		children: [text(reference.label)],
		data: {
			hProperties: {
				className: ["chat-reference"],
				"data-chat-reference": reference.kind,
				"data-chat-reference-index": String(index),
			},
		},
	};
}

function replaceTextNode(
	node: MarkdownNode,
	model: ReferenceRenderModel,
	handled: Set<number>,
): MarkdownNode[] {
	let start = node.position?.start.offset;
	let end = node.position?.end.offset;
	if (
		start === undefined
		|| end === undefined
		|| node.value === undefined
		|| model.source.slice(start, end) !== node.value
	) return [node];
	let references = model.references
		.map((reference, index) => ({ reference, index }))
		.filter(item => item.reference.start >= start && item.reference.end <= end);
	if (references.length === 0) return [node];

	let result: MarkdownNode[] = [];
	let cursor = start;
	for (let item of references) {
		if (item.reference.start > cursor) {
			result.push(text(model.source.slice(cursor, item.reference.start)));
		}
		result.push(referenceNode(item.reference, item.index));
		handled.add(item.index);
		cursor = item.reference.end;
	}
	if (cursor < end) result.push(text(model.source.slice(cursor, end)));
	return result;
}

function offset(node: MarkdownNode, edge: "start" | "end"): number | undefined {
	return node.position?.[edge].offset;
}

function replaceContainedRange(
	node: MarkdownNode,
	model: ReferenceRenderModel,
	reference: Chat.Reference,
	index: number,
	blocked: boolean,
): boolean {
	if (!node.children || blocked) return false;
	for (let child of node.children) {
		let start = offset(child, "start");
		let end = offset(child, "end");
		if (
			start !== undefined
			&& end !== undefined
			&& start <= reference.start
			&& end >= reference.end
			&& replaceContainedRange(
				child,
				model,
				reference,
				index,
				BLOCKED.has(child.type),
			)
		) return true;
	}

	let overlapping = node.children.map((child, childIndex) => ({
		child,
		childIndex,
		start: offset(child, "start"),
		end: offset(child, "end"),
	})).filter(item =>
		item.start !== undefined && item.end !== undefined
		&& item.start < reference.end && item.end > reference.start
	);
	if (overlapping.length === 0) return false;
	let first = overlapping[0]!;
	let last = overlapping.at(-1)!;
	if (first.start! > reference.start || last.end! < reference.end) return false;
	let covered = reference.start;
	for (let item of overlapping) {
		if (item.start! > covered) return false;
		let partiallyCovered = item.start! < reference.start || item.end! > reference.end;
		if (partiallyCovered) {
			if (
				item.child.type !== "text"
				|| item.child.value === undefined
				|| model.source.slice(item.start, item.end) !== item.child.value
			) return false;
		} else if (BLOCKED.has(item.child.type) && item.child.type !== "link") {
			return false;
		}
		covered = Math.max(covered, item.end!);
	}
	if (covered < reference.end) return false;

	let replacement = node.children.slice(0, first.childIndex);
	if (first.child.type === "text" && first.start! < reference.start) {
		replacement.push(text(model.source.slice(first.start, reference.start)));
	}
	replacement.push(referenceNode(reference, index));
	if (last.child.type === "text" && last.end! > reference.end) {
		replacement.push(text(model.source.slice(reference.end, last.end)));
	}
	replacement.push(...node.children.slice(last.childIndex + 1));
	node.children = replacement;
	return true;
}

/** Replace only ranges represented by literal Markdown text nodes. */
export function applyReferenceNodes(tree: MarkdownNode, model: ReferenceRenderModel): void {
	let handled = new Set<number>();
	let visit = (node: MarkdownNode, blocked: boolean) => {
		if (!node.children) return;
		let children: MarkdownNode[] = [];
		let childBlocked = blocked || BLOCKED.has(node.type);
		for (let child of node.children) {
			if (child.type === "text" && !childBlocked) {
				children.push(...replaceTextNode(child, model, handled));
			} else {
				visit(child, childBlocked);
				children.push(child);
			}
		}
		node.children = children;
	};
	visit(tree, false);
	for (let index = model.references.length - 1; index >= 0; index--) {
		if (handled.has(index)) continue;
		replaceContainedRange(tree, model, model.references[index]!, index, false);
	}
}

export function referenceRemarkPlugin(model: ReferenceRenderModel) {
	return (tree: MarkdownNode) => applyReferenceNodes(tree, model);
}
