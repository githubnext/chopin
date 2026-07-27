/**
 * Rendering hook for decorator nodes.
 *
 * `@chopin/dialect` defines the document model and must stay usable headlessly on the
 * server, so it cannot depend on React. `@chopin/editor` registers renderers here at
 * import time and the nodes call through, which keeps one node type per
 * component — replacing the class in the browser would change identity and
 * break Yjs synchronisation.
 */

import type { LexicalNode } from "lexical";

/** Returns the framework-specific output for `decorate()`. */
export type Renderer<T extends LexicalNode = LexicalNode> = (node: T) => unknown;

const renderers = new Map<string, Renderer>();

/** Register how a node type renders. Headless callers simply never register. */
export function setRenderer<T extends LexicalNode>(type: string, render: Renderer<T>): void {
	renderers.set(type, render as Renderer);
}

/** Render a node, or nothing when no renderer is registered. */
export function render(node: LexicalNode): unknown {
	return renderers.get(node.getType())?.(node) ?? null;
}
