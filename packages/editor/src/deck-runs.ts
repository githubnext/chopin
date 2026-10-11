/**
 * Which decisions sit together closely enough to be worked through as a deck.
 *
 * "Related" is adjacency only: cards with nothing but empty caret paragraphs
 * between them. One Planner ask anchored to one block inserts its cards this
 * way, so a batch becomes a deck without any new record.
 */

import { $getRoot, $isParagraphNode } from "lexical";

import { $isQuestionnaireNode } from "@chopin/dialect";

export type MemberState = "open" | "settled" | "hidden";

export function $collectDecisionRuns(): string[][] {
	let runs: string[][] = [];
	let current: string[] = [];
	let close = () => {
		if (current.length > 1) runs.push(current);
		current = [];
	};
	for (let node of $getRoot().getChildren()) {
		if ($isQuestionnaireNode(node)) current.push(node.getId());
		else if (!($isParagraphNode(node) && node.getChildrenSize() === 0)) close();
	}
	close();
	return runs;
}

export function deckLayout(
	members: ReadonlyArray<{ id: string; state: MemberState }>,
): { lead: string; members: string[] } | undefined {
	let visible = members.filter(member => member.state !== "hidden");
	if (visible.length < 2 || !visible.some(member => member.state === "open")) return undefined;
	return { lead: visible[0]!.id, members: visible.map(member => member.id) };
}
