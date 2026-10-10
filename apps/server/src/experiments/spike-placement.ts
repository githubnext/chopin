import * as Y from "yjs";
import { parse } from "@chopin/dialect/parse";
import { serialize } from "@chopin/dialect/serialize";
import { assert } from "@chopin/dialect/validate";

import * as room from "../plan/room";
import * as Service from "../plan/service";

import type { RootContent } from "mdast";

export type CalloutPlacement = "placed" | "unchanged" | "missing" | "deferred";

function calloutId(node: RootContent): string | undefined {
	if (node.type !== "mdxJsxFlowElement" || node.name !== "Callout") return undefined;
	let id = node.attributes.find(item => item.type === "mdxJsxAttribute" && item.name === "id");
	return typeof id?.value === "string" ? id.value : undefined;
}

/** Callout ids present at the top level of a source. */
export function callouts(source: string): Set<string> {
	return new Set(parse(source).children.flatMap(node => calloutId(node) ?? []));
}

function blockSource(node: RootContent): string {
	return serialize({ type: "root", children: [node] });
}

/**
 * Replace a spike's callout in place, or insert it under the one block whose digest matches
 * `after`. An ambiguous or vanished passage is `missing` rather than a guess.
 */
export function withCallout(
	children: RootContent[],
	input: { callout: string; node: RootContent; after?: string },
): RootContent[] | "missing" | "unchanged" {
	let next = [...children];
	let existing = next.findIndex(node => calloutId(node) === input.callout);
	if (existing >= 0) {
		if (blockSource(next[existing]) === blockSource(input.node)) return "unchanged";
		next[existing] = input.node;
		return next;
	}
	if (!input.after) return "missing";
	let matches = next.flatMap((node, index) =>
		room.digest(blockSource(node)) === input.after ? [index] : []
	);
	if (matches.length !== 1) return "missing";
	next.splice(matches[0] + 1, 0, input.node);
	return next;
}

/** Validate a callout change and reconcile it into a staged document. */
export function reconcileCallout(
	document: room.Document,
	input: { callout: string; node: RootContent; after?: string },
): room.Mutation | "missing" | "unchanged" {
	let root = parse(room.project(document));
	let children = withCallout(root.children, input);
	if (typeof children === "string") return children;
	let next = serialize({ ...root, children });
	let parsed = parse(next);
	assert(parsed, { bytes: new TextEncoder().encode(next).byteLength });
	if (parsed.children.length !== children.length) throw new Error("callout did not round-trip");
	room.validate(next);
	return room.reconcile(document, root.children, children) ?? "unchanged";
}

export function placeSpikeCallout(
	plan: Service.Plan,
	input: { callout: string; node: RootContent; after?: string },
): Promise<CalloutPlacement> {
	return Service.exclusive(plan, async () => {
		if (Service.implementationActive(plan)) return "deferred";
		let document = await room.restore(
			plan.document.epoch,
			Y.encodeStateAsUpdate(plan.document.doc),
			room.project(plan.document),
			[],
		);
		document.seq = plan.document.seq;
		try {
			let mutation = reconcileCallout(document, input);
			if (typeof mutation === "string") return mutation;
			await Service.publishStaged(plan, plan.server, plan.id, { ...plan, document }, mutation, {
				agent: true,
			});
			return "placed";
		} finally {
			document.doc.destroy();
		}
	});
}
