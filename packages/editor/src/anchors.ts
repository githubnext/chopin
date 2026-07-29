/**
 * Where a decision lives in the prose.
 *
 * The server says which blocks each of a questionnaire's decisions produced,
 * as Yjs relative positions. Resolving one gives a Lexical node key, and from
 * there the element on screen — which is what lets hovering a decision light up
 * the passage it belongs to, and clicking it go there.
 *
 * Resolution has to happen here rather than server-side because a Lexical key
 * is per-editor: the server's key for a block means nothing in this browser.
 * The position is the shared thing, and every client resolves it for itself.
 */

import * as Y from "yjs";

import type { Binding } from "@lexical/yjs";
import type { Plan } from "@chopin/protocol";

/** Where one decision lives, resolved to the nodes it names in this editor. */
export type Related = {
	widget: string;
	question: string;
	keys: string[];
	/** True when the agent has yet to review this since the plan changed. */
	pending: boolean;
};

function decode(value: string): Uint8Array {
	let binary = atob(value);
	let out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
	return out;
}

/** The local node an anchor names, if this document still has it. */
export function resolve(binding: Binding, anchor: Plan.Anchor): string | undefined {
	if (anchor.orphaned) return undefined;

	try {
		let relative = Y.decodeRelativePosition(decode(anchor.position));
		let absolute = Y.createAbsolutePositionFromRelativePosition(relative, binding.doc, false);
		if (!absolute) return undefined;

		for (let [key, collab] of binding.collabNodeMap) {
			if (collab.getSharedType() === absolute.type) return key;
		}
	} catch {
		// A position from a history this document no longer holds. The server
		// rebases these; until it has, there is simply nothing to highlight.
	}
	return undefined;
}

/** Every relationship the plan holds, resolved against this editor. */
export function relate(binding: Binding, widgets: Plan.WidgetAnchors[]): Related[] {
	let out: Related[] = [];

	for (let widget of widgets) {
		for (let [question, set] of Object.entries(widget.questions)) {
			let keys = set.anchors
				.map(anchor => resolve(binding, anchor))
				.filter((key): key is string => !!key);

			out.push({ widget: widget.widget, question, keys, pending: set.pending });
		}
	}

	return out;
}

/** How much prose each decision resolves to, for the card that offers it. */
export function counts(related: Related[], widget: string): { [question: string]: number } {
	let out: { [question: string]: number } = {};

	for (let item of related) {
		if (item.widget !== widget) continue;
		// A pending relationship resolves to nothing on purpose: it is what
		// makes the text inert rather than offering a jump that may be stale.
		out[item.question] = item.pending ? 0 : item.keys.length;
	}

	return out;
}
