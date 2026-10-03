import { serialize } from "@chopin/dialect/serialize";

import type { RootContent } from "mdast";

const PROTECTED = new Set(["Questionnaire", "Decision", "Research"]);

function collect(nodes: RootContent[]): Map<string, { type: string; source: string }> | string {
	let found = new Map<string, { type: string; source: string }>();
	let walk = (node: RootContent): string | undefined => {
		if (
			(node.type === "mdxJsxFlowElement" || node.type === "mdxJsxTextElement")
			&& node.name && PROTECTED.has(node.name)
		) {
			let id = node.attributes.find(attribute =>
				attribute.type === "mdxJsxAttribute" && attribute.name === "id"
				&& typeof attribute.value === "string"
			);
			if (!id || typeof id.value !== "string" || !id.value) {
				return `a ${node.name} projection is missing its id`;
			}
			if (found.has(id.value)) return `\`${id.value}\` appears twice`;
			found.set(id.value, {
				type: node.name,
				source: serialize({ type: "root", children: [node] }),
			});
		}
		if ("children" in node && Array.isArray(node.children)) {
			for (let child of node.children) {
				let failure = walk(child as RootContent);
				if (failure) return failure;
			}
		}
		return undefined;
	};
	for (let node of nodes) {
		let failure = walk(node);
		if (failure) return failure;
	}
	return found;
}

/** IDs of new atomic references whose records must be checked before accepting a browser batch. */
export function newResearchProjections(base: RootContent[], next: RootContent[]): string[] {
	let current = collect(base);
	let proposed = collect(next);
	if (typeof current === "string" || typeof proposed === "string") return [];
	return [...proposed].flatMap(([id, value]) =>
		value.type === "Research" && !current.has(id) ? [id] : []
	);
}

/** Existing research references removed from a browser batch need terminal request authority. */
export function removedResearchProjections(base: RootContent[], next: RootContent[]): string[] {
	let current = collect(base);
	let proposed = collect(next);
	if (typeof current === "string" || typeof proposed === "string") return [];
	return [...current].flatMap(([id, value]) =>
		value.type === "Research" && !proposed.has(id) ? [id] : []
	);
}

/** Protected components may move, but browser and Planner prose edits cannot change their records. */
export function protectProjections(
	base: RootContent[],
	next: RootContent[],
	allowedResearch = new Set<string>(),
	removableResearch = new Set<string>(),
): string | undefined {
	let current = collect(base);
	if (typeof current === "string") return current;
	let proposed = collect(next);
	if (typeof proposed === "string") return proposed;
	for (let [id, value] of current) {
		let replacement = proposed.get(id);
		if (!replacement) {
			if (value.type === "Research" && removableResearch.has(id)) continue;
			return "Existing Questionnaire, Decision, and Research projections cannot be dropped.";
		}
		if (replacement.type !== value.type || replacement.source !== value.source) {
			return "Existing Questionnaire, Decision, and Research projections cannot be altered.";
		}
	}
	for (let id of proposed.keys()) {
		if (!current.has(id)) {
			if (proposed.get(id)?.type === "Research" && allowedResearch.has(id)) continue;
			return "Questionnaire, Decision, and Research projections cannot be authored by rewriting the plan.";
		}
	}
	return undefined;
}
