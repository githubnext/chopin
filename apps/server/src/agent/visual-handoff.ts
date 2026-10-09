import { parse } from "@chopin/dialect/parse";

import type { Operation } from "../plan/edit";
import type { VisualReceipt, VisualTarget } from "./visual-receipt";
import type { JevAsk } from "./visual-routing";

export type VisualSession = {
	ask: JevAsk;
	pending?: {
		id: string;
		member: { entryId: string; turnId: string; lifecycle: number };
		passage: string;
		receipt: VisualReceipt;
	};
};

type WriteOperation = Extract<Operation, { source: string }>;

function write(operation: Operation): operation is WriteOperation {
	return "source" in operation;
}

function target(operation: WriteOperation): VisualTarget {
	return "index" in operation
		? { op: operation.op, index: operation.index }
		: { op: operation.op };
}

/** Only one new paragraph is supported in this slice. */
export function visualCandidate(operation: Operation): {
	passage: string;
	target: VisualTarget;
} {
	if (!write(operation)) throw new Error("visual assessment requires an insert or replace");
	let root = parse(operation.source);
	if (root.children.length !== 1 || root.children[0]?.type !== "paragraph") {
		throw new Error("visual assessment supports exactly one explanatory paragraph");
	}
	let position = root.children[0].position;
	let start = position?.start.offset;
	let end = position?.end.offset;
	if (start === undefined || end === undefined) {
		throw new Error("visual paragraph has no source span");
	}
	let passage = operation.source.slice(start, end);
	if (!passage.trim() || passage.length > 2_000) {
		throw new Error("visual passage must contain 1 to 2000 characters");
	}
	return { passage, target: target(operation) };
}

/** Multi-operation writes stay disabled until each new passage has its own receipt. */
export function visualWrite(operations: Operation[]): {
	target: VisualTarget;
	authored: string;
} | undefined {
	let written = operations.filter(write);
	if (!written.length) return undefined;
	let explanatory = written.filter(operation => {
		let nodes = parse(operation.source).children;
		if (nodes.length === 1 && nodes[0]?.type === "heading") return false;
		if (nodes[0]?.type !== "paragraph") {
			throw new Error("visual routing supports only headings or one explanatory paragraph");
		}
		return true;
	});
	if (!explanatory.length) return undefined;
	if (written.length !== 1 || operations.length !== 1) {
		throw new Error("visual routing supports one write operation per batch");
	}
	return { target: target(written[0]!), authored: written[0]!.source };
}
