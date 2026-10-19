import type { MarkdownNode } from "./reference-markdown";

type Node = MarkdownNode & { ordered?: boolean; start?: number; spread?: boolean };

/** A line that starts a numbered item: `3. ` or `3) ` at its start. */
let MARKER = /\n(\d{1,9})([.)])[ \t]+/g;
let LEADING = /^(\d{1,9})([.)])[ \t]+/;

/** The unescaped numbered markers that start a line of a paragraph's own source. */
function sourceMarkers(paragraph: Node, source: string): Set<string> {
	let start = paragraph.position?.start.offset;
	let end = paragraph.position?.end.offset;
	let found = new Set<string>();
	if (start === undefined || end === undefined) return found;
	let raw = source.slice(start, end);
	for (let match of raw.matchAll(/\n(?:[ \t]*>)*[ \t]*(\d{1,9})([.)])[ \t]/g)) {
		found.add(`${Number(match[1])}${match[2]}`);
	}
	return found;
}

/**
 * The paragraph split into its lead and the numbered items that continue it, or nothing when it
 * has none. CommonMark lets only a list that starts at 1 interrupt a paragraph, so a list that
 * carries on its numbering after a lead-in line ("Needs task 1 first:\n3. …") would otherwise read
 * as one run-on paragraph.
 */
function split(paragraph: Node, source: string): Node[] | undefined {
	let markers = sourceMarkers(paragraph, source);
	if (markers.size === 0) return undefined;
	let lead: Node[] = [];
	let items: Array<{ start: number; children: Node[] }> = [];
	let current = lead;
	let open = (number: string, delimiter: string): boolean => {
		if (!markers.has(`${Number(number)}${delimiter}`)) return false;
		let item = { start: Number(number), children: [] as Node[] };
		items.push(item);
		current = item.children;
		return true;
	};
	let children = paragraph.children ?? [];
	children.forEach((child, index) => {
		if (child.type !== "text" || child.value === undefined) {
			current.push(child);
			return;
		}
		let value = child.value;
		let cursor = 0;
		let leading = children[index - 1]?.type === "break" && value.match(LEADING);
		if (leading && open(leading[1]!, leading[2]!)) cursor = leading[0].length;
		for (let match of value.matchAll(MARKER)) {
			if (match.index < cursor) continue;
			let before = value.slice(cursor, match.index);
			let previous = current;
			if (!open(match[1]!, match[2]!)) continue;
			if (before) previous.push({ type: "text", value: before });
			cursor = match.index + match[0].length;
		}
		let rest = value.slice(cursor);
		if (rest) current.push(cursor === 0 ? child : { type: "text", value: rest });
	});
	if (items.length === 0) return undefined;
	let trim = (nodes: Node[]) => {
		while (nodes.at(-1)?.type === "break") nodes.pop();
		return nodes;
	};
	if (trim(lead).length === 0 || items.some(item => trim(item.children).length === 0)) {
		return undefined;
	}
	return [
		{ ...paragraph, children: lead },
		{
			type: "list",
			ordered: true,
			start: items[0]!.start,
			spread: false,
			children: items.map(item => ({
				type: "listItem",
				spread: false,
				children: [{ type: "paragraph", children: item.children }],
			})),
		},
	];
}

/** Render numbered items that continue a lead-in paragraph as the list their author meant. */
export function orderedRunsRemarkPlugin() {
	return (tree: Node, file: { value: unknown }) => {
		let source = String(file.value);
		let visit = (node: Node) => {
			if (!node.children) return;
			node.children = node.children.flatMap(child => {
				if (child.type === "paragraph") return split(child, source) ?? [child];
				visit(child);
				return [child];
			});
		};
		visit(tree);
	};
}
