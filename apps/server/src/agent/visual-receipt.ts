import { createHash } from "node:crypto";

import { parseDiagramSource, renderDiagram } from "@chopin/diagrams";
import { SEECODE_LANGUAGE } from "@chopin/dialect/dialect";
import { parse } from "@chopin/dialect/parse";

import type { VisualRoute } from "./visual-routing";

export type VisualTarget =
	| { op: "insert" | "replace"; index: number }
	| { op: "insert_root" | "replace_root" };

/** Kept by the server for one Planner turn; it is never accepted from the model as authority. */
export type VisualReceipt = {
	revision: number;
	passageSha256: string;
	target: VisualTarget;
	route: VisualRoute;
};

export type VisualCheck =
	| { ok: true }
	| {
		ok: false;
		reason:
			| "missing-route"
			| "stale-route"
			| "changed-passage"
			| "wrong-placement"
			| "missing-selected-visual"
			| "unassessed-content"
			| "wrong-type"
			| "invalid-visual";
		problems?: { code: string; at: string; msg: string }[];
	};

function digest(source: string): string {
	return createHash("sha256").update(source).digest("hex");
}

export function bindVisualRoute(input: {
	revision: number;
	passage: string;
	target: VisualTarget;
	route: VisualRoute;
}): VisualReceipt {
	if (!Number.isSafeInteger(input.revision) || input.revision < 0 || !input.passage.trim()) {
		throw new Error("invalid visual route source");
	}
	if (
		"index" in input.target
		&& (!Number.isSafeInteger(input.target.index) || input.target.index < 0)
	) throw new Error("invalid visual route target");
	return {
		revision: input.revision,
		passageSha256: digest(input.passage),
		target: { ...input.target },
		route: { ...input.route },
	};
}

/** Pure pre-commit check; the ordinary edit validator still validates the complete MDX. */
export function checkVisualRoute(input: {
	required: boolean;
	receipt: VisualReceipt | undefined;
	revision: number;
	passage: string;
	target: VisualTarget;
	authored: string;
}): VisualCheck {
	if (!input.required) return { ok: true };
	let receipt = input.receipt;
	if (!receipt) return { ok: false, reason: "missing-route" };
	if (input.revision !== receipt.revision) return { ok: false, reason: "stale-route" };
	if (digest(input.passage) !== receipt.passageSha256) {
		return { ok: false, reason: "changed-passage" };
	}
	if (
		input.target.op !== receipt.target.op
		|| ("index" in input.target ? input.target.index : undefined)
			!== ("index" in receipt.target ? receipt.target.index : undefined)
	) return { ok: false, reason: "wrong-placement" };

	let nodes: ReturnType<typeof parse>["children"];
	try {
		nodes = parse(input.authored).children;
	} catch {
		return {
			ok: false,
			reason: "invalid-visual",
			problems: [{ code: "E_MDX", at: "source", msg: "Invalid document source." }],
		};
	}
	// This first bounded handoff retains the assessed paragraph as prose beside its visual.
	let first = nodes[0];
	let retained = first?.type === "paragraph"
		&& first.position?.start.offset !== undefined
		&& first.position.end.offset !== undefined
		&& input.authored.slice(first.position.start.offset, first.position.end.offset)
			=== input.passage;
	if (!retained) return { ok: false, reason: "changed-passage" };
	if (nodes.length > 2) return { ok: false, reason: "unassessed-content" };
	let second = nodes[1];
	if (receipt.route.kind === "table") {
		if (!second) return { ok: false, reason: "missing-selected-visual" };
		return second.type === "table" ? { ok: true } : { ok: false, reason: "wrong-type" };
	}
	if (receipt.route.kind === "prose") {
		return !second
			? { ok: true }
			: second.type === "table" || second.type === "code"
			? { ok: false, reason: "wrong-type" }
			: { ok: false, reason: "unassessed-content" };
	}
	if (!second) return { ok: false, reason: "missing-selected-visual" };
	if (second.type !== "code" || second.lang !== SEECODE_LANGUAGE) {
		return { ok: false, reason: "wrong-type" };
	}
	let parsed = parseDiagramSource(second.value);
	if (!parsed.ok) {
		return {
			ok: false,
			reason: "invalid-visual",
			problems: [{ code: "E_JSON", at: "diagram", msg: parsed.message }],
		};
	}
	let rendered = renderDiagram(parsed.spec);
	if (!rendered.ok) {
		return {
			ok: false,
			reason: "invalid-visual",
			problems: rendered.problems.slice(0, 3).map(problem => ({
				code: problem.code.slice(0, 24),
				at: problem.at.slice(0, 100),
				msg: problem.msg.slice(0, 160),
			})),
		};
	}
	return rendered.type === receipt.route.type
		? { ok: true }
		: { ok: false, reason: "wrong-type" };
}
