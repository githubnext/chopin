/**
 * Shared plumbing for plan component nodes.
 *
 * Component attributes live in Lexical `NodeState` rather than plain class
 * fields. Node state is synced correctly by `@lexical/yjs`, whereas ordinary
 * properties only sync when they are own enumerable fields assigned in the
 * constructor — a footgun the Lexical docs call out explicitly.
 */

import type { Nodes, Parent } from "mdast";
import type { MdxJsxAttribute, MdxJsxFlowElement, MdxJsxTextElement } from "mdast-util-mdx-jsx";

export type Jsx = MdxJsxFlowElement | MdxJsxTextElement;

/** Read a string attribute off a parsed component. Validation has already run. */
export function attribute(node: Jsx, name: string): string | undefined {
	for (let item of node.attributes) {
		if (item.type !== "mdxJsxAttribute" || item.name !== name) continue;
		return typeof item.value === "string" ? item.value : undefined;
	}
	return undefined;
}

/** Build MDX attributes, dropping empties so optional values stay out of source. */
export function attributes(values: Record<string, string | undefined>): MdxJsxAttribute[] {
	let out: MdxJsxAttribute[] = [];
	for (let [name, value] of Object.entries(values)) {
		if (value === undefined || value === "") continue;
		out.push({ type: "mdxJsxAttribute", name, value });
	}
	return out;
}

/** Attributes every identified component carries, in canonical order. */
export function identity(id: string, rest: Record<string, string | undefined> = {}) {
	return attributes({ id, ...rest });
}

/** Matches a flow component by name. */
export function isFlow(name: string) {
	return (node: Nodes): boolean => node.type === "mdxJsxFlowElement" && node.name === name;
}

/** Component visitors must outrank MDXEditor's generic JSX visitor. */
export const PRIORITY = 100;

export function children(node: Nodes): Nodes[] {
	return (node as Parent).children ?? [];
}
