import { parse } from "@chopin/dialect";
import { SEECODE_LANGUAGE } from "@chopin/dialect/dialect";
import * as Room from "../plan/room";
import type { Plan } from "../plan/service";
import * as Prose from "./prose";
import type { Placement } from "./service-relationships";

type Block = ReturnType<typeof parse>["children"][number];

/**
 * The bounded passage a follow-up target may name: a paragraph, then contiguous paragraphs,
 * tables or diagrams, at most eight. A named paragraph takes the tables and diagrams after it.
 */
function passage(
	blocks: Block[],
	digests: string[],
	addresses: Placement["blocks"],
): number[] | undefined {
	let indices = new Set<number>();
	for (let address of addresses) {
		if (digests[address.index] !== address.digest) return;
		indices.add(address.index);
		if (blocks[address.index]?.type !== "paragraph") continue;
		for (let index = address.index + 1; index < blocks.length; index++) {
			let block = blocks[index]!;
			if (block.type === "mdxJsxFlowElement" && block.name === "Questionnaire") continue;
			if (
				block.type !== "table" && !(block.type === "code" && block.lang === SEECODE_LANGUAGE)
			) break;
			indices.add(index);
		}
	}
	let ordered = [...indices].sort((a, b) => a - b);
	if (!ordered.length || ordered.length > 8 || blocks[ordered[0]!]!.type !== "paragraph") return;
	for (let index = ordered[0]!; index <= ordered.at(-1)!; index++) {
		let block = blocks[index]!;
		if (block.type === "mdxJsxFlowElement" && block.name === "Questionnaire") continue;
		if (
			!indices.has(index) || block.type !== "paragraph" && block.type !== "table"
				&& !(block.type === "code" && block.lang === SEECODE_LANGUAGE)
		) return;
	}
	return ordered;
}

/**
 * Only an explicit reviewed placement may replace a lost follow-up target, or written prose
 * whose every block was lost. Prose that still resolves is never rewritten by a placement.
 */
export function reanchorDecisionRelationships(plan: Plan, updates: Placement[]): string[] {
	let byWidget = new Map(updates.map(update => [update.widget, update]));
	let scopes = new Set(updates.flatMap(update => {
		let record = plan.records.get(update.widget);
		return record?.origin === "planner" && record.followUp ? [record.followUp.scope] : [];
	}));
	let blocks = parse(Room.project(plan.document)).children;
	let digests = Room.digests(plan.document);
	let errors: string[] = [];
	for (let update of updates) {
		let record = plan.records.get(update.widget);
		if (
			!record || record.origin !== "conversation" && record.origin !== "planner"
			|| record.status !== "answered" || record.definition.questions.length !== 1
			|| record.followUp || !Prose.orphaned(record.prose)
		) continue;
		// A write-up is one paragraph; a dropped follow-up's prose was a bounded passage.
		let bounded = record.origin === "planner" && record.prose!.length > 1;
		let indices: number[] | undefined = [];
		if (update.blocks.length) {
			let [address] = update.blocks;
			indices = bounded
				? passage(blocks, digests, update.blocks)
				: update.blocks.length === 1 && blocks[address!.index]?.type === "paragraph"
						&& digests[address!.index] === address!.digest
				? [address!.index]
				: undefined;
		}
		if (!indices) {
			errors.push(
				bounded
					? "Decision prose must name one bounded passage or no blocks."
					: "Decision prose must name one paragraph or no blocks.",
			);
			continue;
		}
		plan.records.set(record.id, {
			...record,
			prose: indices.map(index => Room.anchorAt(plan.document, index, digests[index]!)),
		});
	}
	for (let scope of scopes) {
		let peers = [...plan.records.values()].filter(record => record.followUp?.scope === scope);
		if (peers.every(peer => byWidget.get(peer.id)?.blocks.length === 0)) continue;
		if (peers.some(peer => !byWidget.get(peer.id)?.blocks.length)) {
			errors.push(
				`Re-anchor every decision sharing this scope together: ${
					peers.map(peer => peer.id).join(", ")
				}`,
			);
			continue;
		}
		let targets = peers.map(peer => passage(blocks, digests, byWidget.get(peer.id)!.blocks));
		let indices = targets[0];
		if (!indices || targets.some(target => JSON.stringify(target) !== JSON.stringify(indices))) {
			errors.push(
				"Decision scope targets must agree on one bounded passage without unrelated gaps.",
			);
			continue;
		}
		let target = indices.map(index => Room.anchorAt(plan.document, index, digests[index]!));
		for (let peer of peers) {
			plan.records.set(peer.id, {
				...peer,
				followUp: { ...peer.followUp!, target },
				...(peer.prose ? { prose: target } : {}),
			});
		}
	}
	return errors;
}
