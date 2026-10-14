import { parse, serialize } from "@chopin/dialect";

import type { RootContent } from "mdast";

type Node = { type: string; depth?: number; children?: unknown[] };

function inline(node: Node): boolean {
	if (["text", "inlineCode", "break"].includes(node.type)) return true;
	return ["strong", "emphasis", "delete", "link"].includes(node.type)
		&& Array.isArray(node.children) && node.children.every(child => inline(child as Node));
}

function list(node: Node): boolean {
	return node.type === "list" && Array.isArray(node.children) && node.children.every(child => {
		let item = child as Node;
		return item.type === "listItem" && Array.isArray(item.children)
			&& item.children.every(part => {
				let block = part as Node;
				return block.type === "paragraph" && block.children?.every(item => inline(item as Node))
					|| list(block);
			});
	});
}

export function supported(node: RootContent): boolean {
	return list(node)
		|| (node.type === "paragraph" || node.type === "heading" && [2, 3].includes(node.depth))
			&& node.children.every(child => inline(child));
}

/** A scoped worker can author ordinary prose, never document titles or domain projections. */
export function canonical(markdown: string): string {
	if (typeof markdown !== "string" || !markdown.trim() || markdown.length > 3_000) {
		throw new Error("document development passage exceeds its text bounds");
	}
	let parsed = parse(markdown);
	if (parsed.children.length !== 1 || !supported(parsed.children[0]!)) {
		throw new Error("document development writes one paragraph, list, or level 2–3 heading");
	}
	return serialize(parsed);
}
