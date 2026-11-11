/**
 * The parts of a document a person can point at from Chat: its headings, its Decisions and its
 * research cards, read from its source so that what the composer offers and what the server later
 * accepts are one list. A part is told by its identity (an anchor, an id), never by its words.
 */

import { parse } from "@chopin/dialect/parse";

import type { Heading, Root, RootContent } from "mdast";

/** The part of a parsed component this reads: its name, attributes and children. */
type MdxJsxFlowElement = {
	type: "mdxJsxFlowElement";
	name: string | null;
	attributes: Array<{ type: string; name?: string; value?: unknown }>;
	children: RootContent[];
};

export type HeadingPointer = { anchor: string; text: string; level: number; line: number };
export type DecisionPointer = { id: string; title: string };
export type DocumentPointers = {
	headings: HeadingPointer[];
	decisions: DecisionPointer[];
	/** The workspace id of each research card, in document order. */
	research: string[];
};

/**
 * A heading's text as an anchor, as GitHub makes one: lowercase, with whatever is not a letter, a
 * digit, a space, a hyphen or an underscore removed and each space a hyphen. Nothing left is
 * `section`.
 */
export function headingAnchor(text: string): string {
	let slug = text.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");
	return slug || "section";
}

function plain(node: RootContent | Heading): string {
	if ("value" in node && typeof node.value === "string") return node.value;
	if ("children" in node) return (node.children as RootContent[]).map(plain).join("");
	return "";
}

function attribute(node: MdxJsxFlowElement, name: string): string | undefined {
	let found = node.attributes.find(item => item.type === "mdxJsxAttribute" && item.name === name);
	return typeof found?.value === "string" ? found.value : undefined;
}

function components(node: RootContent, visit: (element: MdxJsxFlowElement) => void): void {
	if ((node.type as string) === "mdxJsxFlowElement") visit(node as unknown as MdxJsxFlowElement);
	if ("children" in node) {
		for (let child of node.children as RootContent[]) components(child, visit);
	}
}

/** The most of a heading's or a Decision's words a mention shows, so its label fits one token. */
export const MAX_POINTER_TEXT = 100;

/** `text` cut to a whole number of characters, with an ellipsis where it was cut. */
export function shortened(text: string, limit = MAX_POINTER_TEXT): string {
	let characters = [...text];
	return characters.length <= limit ? text : `${characters.slice(0, limit - 1).join("")}…`;
}

/** What the document's source holds; empty for a source that does not parse. */
export function documentPointers(source: string): DocumentPointers {
	let root: Root;
	try {
		root = parse(source);
	} catch {
		return { headings: [], decisions: [], research: [] };
	}
	let seen = new Map<string, number>();
	let headings: HeadingPointer[] = [];
	for (let node of root.children) {
		if (node.type !== "heading") continue;
		let text = plain(node).replace(/\s+/g, " ").trim();
		let base = headingAnchor(text);
		let repeats = seen.get(base) ?? 0;
		seen.set(base, repeats + 1);
		headings.push({
			anchor: repeats === 0 ? base : `${base}-${repeats}`,
			text: shortened(text),
			level: node.depth,
			line: node.position?.start.line ?? 1,
		});
	}
	let decisions: DecisionPointer[] = [];
	let research: string[] = [];
	for (let node of root.children) {
		components(node, element => {
			let id = attribute(element, "id");
			if (!id) return;
			if (element.name === "Research") research.push(id);
			if (element.name !== "Questionnaire") return;
			let question = element.children.find((child): child is RootContent & MdxJsxFlowElement =>
				(child.type as string) === "mdxJsxFlowElement"
				&& (child as unknown as MdxJsxFlowElement).name === "Question"
			);
			let title = question
				? (attribute(question, "header") || attribute(question, "prompt") || "")
				: "";
			decisions.push({ id, title: shortened(title) });
		});
	}
	return { headings, decisions, research };
}

/**
 * The indexes of `titles` a typed query points at, best first and no more than `limit`: a title
 * that starts with it, then one with a word that does, then one that holds it, each in the order
 * given. The case of the query and of a title does not matter. An empty query is every title.
 */
export function matchPointers(titles: readonly string[], query: string, limit: number): number[] {
	let wanted = query.trimStart().toLowerCase();
	let ranked: Array<{ index: number; rank: number }> = [];
	for (let [index, title] of titles.entries()) {
		let lower = title.toLowerCase();
		let rank = !wanted || lower.startsWith(wanted)
			? 0
			: lower.split(/[\s/._-]+/).some(word => word.startsWith(wanted))
					|| lower.includes(` ${wanted}`)
			? 1
			: lower.includes(wanted)
			? 2
			: undefined;
		if (rank !== undefined) ranked.push({ index, rank });
	}
	return ranked.sort((a, b) => a.rank - b.rank || a.index - b.index).slice(0, limit).map(item =>
		item.index
	);
}
