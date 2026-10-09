import { CONTROL_CHARACTER, type Wireframe, type WireframeNode } from "./schema";

/**
 * Write a wireframe in canonical form: two-space indentation, then kind,
 * label, id, flags, properties and target in that order. Parsing the result
 * yields the same tree, except that spans describe the lines of the printed
 * text rather than the source the tree came from: an editor should re-parse
 * after printing to refresh them. The printer does not validate; parse its output to
 * check a tree that was built or edited by hand.
 */
export function printWireframe(wireframe: Wireframe): string {
	let lines: string[] = [];
	let visit = (node: WireframeNode, depth: number) => {
		let indent = "  ".repeat(depth);
		let parts: string[] = [node.kind];
		if (node.label !== undefined) parts.push(quote(node.label));
		if (node.id !== undefined) parts.push(`#${node.id}`);
		parts.push(...node.flags);
		for (let [key, value] of Object.entries(node.props)) {
			let bare = /^[^\s"]+$/.test(value) && !CONTROL_CHARACTER.test(value);
			parts.push(`${key}=${bare ? value : quote(value)}`);
		}
		if (node.target !== undefined) parts.push(`-> ${node.target}`);
		lines.push(indent + parts.join(" "));
		for (let item of node.items) {
			let bare = item.text
				&& item.text === item.text.trim()
				&& !item.text.startsWith('"')
				&& !CONTROL_CHARACTER.test(item.text);
			lines.push(`${indent}  - ${bare ? item.text : quote(item.text)}`);
		}
		for (let child of node.children) visit(child, depth + 1);
	};
	for (let node of wireframe.nodes) visit(node, 0);
	return lines.join("\n");
}

function quote(text: string): string {
	return `"${text.replace(/[\\"]/g, "\\$&").replaceAll("\n", "\\n")}"`;
}
