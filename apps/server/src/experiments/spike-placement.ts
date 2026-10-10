import * as Y from "yjs";
import { parse } from "@chopin/dialect/parse";
import { serialize } from "@chopin/dialect/serialize";
import { ulid } from "@chopin/dialect/ulid";
import { assert } from "@chopin/dialect/validate";

import * as Comments from "../comments/service";
import * as room from "../plan/room";
import * as Service from "../plan/service";
import * as Questions from "../questions/service";

import type { RootContent } from "mdast";

export type CalloutInput = {
	callout: string;
	node: RootContent;
	/** Digest of the passage to insert under when the callout is not in the document. */
	after?: string;
	/** Digest of the callout as last rendered; a different block holds human edits. */
	rendered?: string;
};

/** Where the spike's callout now lives, and the digest of its block. */
export type CalloutPlacement =
	| { status: "placed"; callout: string; digest: string }
	| { status: "unchanged"; callout: string; digest: string }
	| { status: "missing" }
	| { status: "deferred" };

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

export function calloutDigest(node: RootContent): string {
	return room.digest(blockSource(node));
}

function withId(node: RootContent, id: string): RootContent {
	if (node.type !== "mdxJsxFlowElement") return node;
	return {
		...node,
		attributes: node.attributes.map(item =>
			item.type === "mdxJsxAttribute" && item.name === "id" ? { ...item, value: id } : item
		),
	};
}

/**
 * Replace a spike's callout in place while it is still exactly as last rendered, or insert it
 * under the one block whose digest matches `after`. A callout someone edited keeps their edits;
 * the new state goes into a fresh sibling callout directly after it. An ambiguous or vanished
 * passage is `missing` rather than a guess.
 */
export function withCallout(
	children: RootContent[],
	input: CalloutInput,
): { children: RootContent[]; callout: string } | "missing" | "unchanged" {
	let next = [...children];
	let existing = next.findIndex(node => calloutId(node) === input.callout);
	if (existing >= 0) {
		if (blockSource(next[existing]) === blockSource(input.node)) return "unchanged";
		if (input.rendered === undefined || calloutDigest(next[existing]) === input.rendered) {
			next[existing] = input.node;
			return { children: next, callout: input.callout };
		}
		let callout = ulid();
		next.splice(existing + 1, 0, withId(input.node, callout));
		return { children: next, callout };
	}
	if (!input.after) return "missing";
	let matches = next.flatMap((node, index) =>
		room.digest(blockSource(node)) === input.after ? [index] : []
	);
	if (matches.length !== 1) return "missing";
	next.splice(matches[0] + 1, 0, input.node);
	return { children: next, callout: input.callout };
}

/** Validate a callout change and reconcile it into a staged document. */
export function reconcileCallout(
	document: room.Document,
	input: CalloutInput,
): { mutation: room.Mutation; callout: string } | "missing" | "unchanged" {
	let root = parse(room.project(document));
	let placed = withCallout(root.children, input);
	if (typeof placed === "string") return placed;
	let next = serialize({ ...root, children: placed.children });
	let parsed = parse(next);
	assert(parsed, { bytes: new TextEncoder().encode(next).byteLength });
	if (parsed.children.length !== placed.children.length) {
		throw new Error("callout did not round-trip");
	}
	room.validate(next);
	let mutation = room.reconcile(document, root.children, placed.children);
	return mutation ? { mutation, callout: placed.callout } : "unchanged";
}

function digestOf(source: string, callout: string): string | undefined {
	let found = parse(source).children.find(node => calloutId(node) === callout);
	return found && calloutDigest(found);
}

export function placeSpikeCallout(
	plan: Service.Plan,
	input: CalloutInput,
): Promise<CalloutPlacement> {
	return Service.exclusive(plan, async (): Promise<CalloutPlacement> => {
		if (Service.implementationActive(plan)) return { status: "deferred" };
		let document = await room.restore(
			plan.document.epoch,
			Y.encodeStateAsUpdate(plan.document.doc),
			room.project(plan.document),
			[],
		);
		document.seq = plan.document.seq;
		let candidate: Service.Plan = {
			...plan,
			document,
			records: new Map(plan.records),
			threads: new Map(plan.threads),
		};
		try {
			// Carry anchors onto the old document before the edit, as Service.rewrite does.
			Questions.rebase(candidate);
			Comments.rebase(candidate);
			let placed = reconcileCallout(document, input);
			if (placed === "missing") return { status: "missing" };
			if (placed === "unchanged") {
				let digest = digestOf(room.project(document), input.callout);
				return digest
					? { status: "unchanged", callout: input.callout, digest }
					: { status: "missing" };
			}
			Questions.rebase(candidate);
			Comments.rebase(candidate);
			let digest = digestOf(room.project(document), placed.callout);
			if (!digest) throw new Error("callout did not land");
			await Service.publishStaged(plan, plan.server, plan.id, candidate, placed.mutation, {
				agent: true,
			});
			return { status: "placed", callout: placed.callout, digest };
		} finally {
			document.doc.destroy();
		}
	});
}
