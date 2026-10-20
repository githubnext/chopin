import { parse } from "@chopin/dialect";
import { SEECODE_LANGUAGE } from "@chopin/dialect/dialect";
import * as Room from "../plan/room";
import type { Plan } from "../plan/service";
import type { Placement } from "./service-relationships";

/** Only an explicit reviewed placement may replace a lost follow-up target. */
export function reanchorScopes(plan: Plan, updates: Placement[]): string[] {
	let byWidget = new Map(updates.map(update => [update.widget, update]));
	let scopes = new Set(updates.flatMap(update => {
		let record = plan.records.get(update.widget);
		return record?.origin === "planner" && record.followUp ? [record.followUp.scope] : [];
	}));
	let blocks = parse(Room.project(plan.document)).children;
	let digests = Room.digests(plan.document);
	let errors: string[] = [];
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
		let targets = peers.map(peer => {
			let indices = new Set<number>();
			for (let address of byWidget.get(peer.id)!.blocks) {
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
			if (ordered.length > 8 || blocks[ordered[0]!]!.type !== "paragraph") return;
			for (let index = ordered[0]!; index <= ordered.at(-1)!; index++) {
				let block = blocks[index]!;
				if (block.type === "mdxJsxFlowElement" && block.name === "Questionnaire") continue;
				if (
					!indices.has(index) || block.type !== "paragraph" && block.type !== "table"
						&& !(block.type === "code" && block.lang === SEECODE_LANGUAGE)
				) return;
			}
			return ordered;
		});
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
