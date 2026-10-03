import * as Anchors from "./anchors";

import * as Prose from "./prose";
import * as room from "../plan/room";

import type { Plan as Wired } from "@chopin/protocol";

import type { Plan } from "../plan/service";

// Exact archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2 declarations; import/export wrappers only.
export function anchors(plan: Plan): Wired.WidgetAnchors[] {
	return [...plan.records.values()].map(record => Anchors.read(record));
}

export function setProse(plan: Plan, id: string, anchors: Wired.Anchor[]): void {
	let record = plan.records.get(id);
	if (!record) throw new Error(`no questionnaire ${id}`);
	plan.records.set(id, { ...record, prose: anchors });
}

export function prose(plan: Plan): Wired.ProseAnchors[] {
	let out: Wired.ProseAnchors[] = [];
	for (let record of plan.records.values()) {
		if (!record.prose?.length) continue;
		out.push({
			widget: record.id,
			anchors: record.prose,
			orphaned: Prose.orphaned(record.prose),
		});
	}
	return out;
}

export function rebase(plan: Plan, previousSource = plan.persistence?.committedSource): void {
	for (let [id, record] of plan.records) {
		let value = Anchors.read(record);
		let questions: { [question: string]: Wired.AnchorSet } = {};

		for (let [question, set] of Object.entries(value.questions)) {
			questions[question] = carry(plan, set);
		}

		plan.records.set(id, {
			...record,
			anchors: { widget: value.widget, questions },
			...(record.prose ? { prose: Prose.carry(plan.document, record.prose, previousSource) } : {}),
		});
	}
}

export function carry(plan: Plan, set: Wired.AnchorSet): Wired.AnchorSet {
	let anchors = room.rebase(plan.document, set.anchors);
	let lost = anchors.some(anchor => anchor.orphaned);
	return {
		anchors,
		pending: set.pending || lost,
		...(lost ? { reason: "orphaned" as const } : set.reason ? { reason: set.reason } : {}),
	};
}

export function invalidate(plan: Plan, reason: Wired.AnchorReason): void {
	for (let [id, record] of plan.records) {
		plan.records.set(id, { ...record, anchors: Anchors.invalidate(record, reason) });
	}
}

export function outstanding(plan: Plan): Anchors.Pending[] {
	return [...plan.records.values()].flatMap(record => Anchors.pending(record));
}

export function relate(
	plan: Plan,
	widget: string,
	question: string,
	blocks: Array<{ index: number; digest: string }>,
): string | undefined {
	let record = plan.records.get(widget);
	if (!record) return `no questionnaire ${widget}`;

	let current = room.digests(plan.document);
	let anchors: Wired.Anchor[] = [];

	for (let block of blocks) {
		let hash = current[block.index];
		if (!hash) return `no block at index ${block.index}`;
		// The digest is how the agent says which block it meant. If it does not
		// match, the plan moved between reading and anchoring, and quietly
		// anchoring the block that happens to be there now would be worse than
		// saying so.
		if (hash !== block.digest) return `block ${block.index} has changed; read the plan again`;
		anchors.push(room.anchorAt(plan.document, block.index, hash));
	}

	plan.records.set(widget, {
		...record,
		anchors: Anchors.set(Anchors.read(record), question, anchors),
	});
	return undefined;
}

export type Placement = {
	widget: string;
	blocks: Array<{ index: number; digest: string }>;
};

export function place(plan: Plan, updates: Placement[]): room.Mutation | undefined {
	let records = [...plan.records.values()];
	let placements: room.QuestionnairePlacement[] = [];
	let byWidget = new Map(updates.map(update => [update.widget, update]));

	for (let record of records) {
		let update = byWidget.get(record.id);
		if (!update || record.definition.questions.length !== 1 || update.blocks.length === 0) continue;

		let home = update.blocks[0]!;
		let before = records.slice(0, records.indexOf(record)).findLast(candidate => {
			if (candidate.definition.questions.length !== 1) return false;
			let question = candidate.definition.questions[0];
			if (!question) return false;
			let anchor = Anchors.read(candidate).questions[question.id]?.anchors[0];
			return anchor !== undefined && room.matchesAnchor(plan.document, anchor, home.index);
		});

		placements.push({ id: update.widget, at: home, ...(before ? { after: before.id } : {}) });
	}

	return room.placeQuestionnaires(plan.document, placements);
}
