import { resolveWireframeTarget } from "./parse";

import type { Wireframe, WireframeNode, WireframeProblem } from "./schema";

/** A numbered callout and the part it points at, if it points at one. */
export type WireframeCallout = { number: number; text: string; target?: WireframeNode };

/**
 * Every note in reading order, numbered from one, and the numbers each target
 * carries. Targets are matched by identity, so the map belongs to this tree.
 */
export function wireframeCallouts(
	wireframe: Wireframe,
): { callouts: WireframeCallout[]; marks: Map<WireframeNode, number[]> } {
	let callouts: WireframeCallout[] = [];
	let marks = new Map<WireframeNode, number[]>();
	let visit = (node: WireframeNode) => {
		if (node.kind === "note") {
			let number = callouts.length + 1;
			let target = node.target === undefined
				? undefined
				: resolveWireframeTarget(wireframe, node.target);
			callouts.push({ number, text: node.label ?? "", target });
			if (target) marks.set(target, [...(marks.get(target) ?? []), number]);
		}
		node.children.forEach(visit);
	};
	wireframe.nodes.forEach(visit);
	return { callouts, marks };
}

/** What the wireframe is of: its first top-level label, or the first title inside it. */
export function wireframeName(wireframe: Wireframe): string | undefined {
	let first = wireframe.nodes[0];
	if (!first) return undefined;
	if (first.label !== undefined && first.kind !== "note") return oneLine(first.label);
	let title = (node: WireframeNode): string | undefined => {
		if (node.kind === "title" && node.label !== undefined) return node.label;
		for (let child of node.children) {
			let found = title(child);
			if (found !== undefined) return found;
		}
		return undefined;
	};
	let found = title(first);
	return found === undefined ? undefined : oneLine(found);
}

/** The accessible name of the rendered region. */
export function wireframeLabel(wireframe: Wireframe): string {
	let name = wireframeName(wireframe);
	return name ? `${name} wireframe` : "Wireframe";
}

const NAMES: Record<WireframeNode["kind"], string> = {
	panel: "Panel",
	header: "Header",
	row: "Row",
	stack: "Stack",
	card: "Card",
	title: "Title",
	text: "Text",
	button: "Button",
	badge: "Badge",
	disclosure: "Disclosure",
	list: "List",
	note: "Note",
	input: "Field",
	tabs: "Tabs",
	nav: "Navigation",
	image: "Image",
	divider: "Divider",
};

/**
 * One line of the text alternative: what a part is, what it says and the
 * state its flags give it. Layout-only parts read as their kind alone.
 */
export function describeWireframePart(node: WireframeNode): string {
	let words = [NAMES[node.kind]];
	if (node.label !== undefined) words.push(`“${oneLine(node.label)}”`);
	let states: string[] = [];
	if (node.kind === "input") {
		if (node.props.value !== undefined) states.push(`value “${oneLine(node.props.value)}”`);
		else if (node.props.placeholder !== undefined) {
			states.push(`placeholder “${oneLine(node.props.placeholder)}”`);
		}
	}
	if (node.kind === "badge" && node.props.tone && node.props.tone !== "neutral") {
		states.push(node.props.tone);
	}
	if (node.kind === "row" && node.flags.includes("flow")) states.push("a sequence");
	for (let flag of node.flags) {
		if (flag === "flow" || flag === "wrap" || flag === "vertical") continue;
		states.push(flag);
	}
	if (node.kind === "disclosure" && !node.flags.includes("open")) states.push("closed");
	let active = node.props.active ?? (node.kind === "tabs" ? "1" : undefined);
	let current = active === undefined ? undefined : node.items[Number(active) - 1];
	if (current) states.push(`“${oneLine(current.text)}” selected`);
	return states.length ? `${words.join(" ")}, ${states.join(", ")}` : words.join(" ");
}

/** The first problem, as the author should read it. */
export function describeWireframeProblem(problems: readonly WireframeProblem[]): string {
	let first = problems[0];
	if (!first) return "The wireframe could not be read.";
	let more = problems.length - 1;
	return `Line ${first.line}: ${first.message}${
		more ? ` (${more} more ${more === 1 ? "problem" : "problems"})` : ""
	}`;
}

function oneLine(text: string): string {
	return text.replace(/\s*\n\s*/g, " ");
}
