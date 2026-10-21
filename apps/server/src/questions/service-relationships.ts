import * as Anchors from "./anchors";
import { parse } from "@chopin/dialect";
import { SEECODE_LANGUAGE } from "@chopin/dialect/dialect";

import * as Prose from "./prose";
import * as room from "../plan/room";

import type { Plan as Wired } from "@chopin/protocol";

import type { Plan } from "../plan/service";
import type { Record } from "./record-types";

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
			...(record.followUp
				? {
					followUp: {
						...record.followUp,
						target: Prose.carry(plan.document, record.followUp.target, previousSource),
					},
				}
				: {}),
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

export function invalidate(
	plan: Plan,
	reason: Wired.AnchorReason,
	/** From before a rewrite: a reviewed link whose blocks all kept their digest stays reviewed. */
	before?: Map<string, Wired.WidgetAnchors>,
): void {
	for (let [id, record] of plan.records) {
		plan.records.set(id, {
			...record,
			anchors: Anchors.invalidate(record, reason, before?.get(id)),
		});
	}
}

/** A card the Planner asked itself, as opposed to a workflow's, a person's or Chat's. */
function plannerOwn(record: Record): boolean {
	return record.origin === "planner"
		&& !record.definition.questions.some(question => question.verbatim);
}

/** Per card, per question: the headings above its first linked block, nearest first. */
export type Sections = Map<string, { [question: string]: Wired.Anchor[] }>;

/** Before a whole-document rewrite, where each of the Planner's own cards could fall back to. */
export function sections(plan: Plan): Sections {
	let blocks = parse(room.project(plan.document)).children;
	let digests = room.digests(plan.document);
	let out: Sections = new Map();
	for (let record of plan.records.values()) {
		if (!plannerOwn(record)) continue;
		let questions: { [question: string]: Wired.Anchor[] } = {};
		for (let [question, set] of Object.entries(Anchors.read(record).questions)) {
			let first = set.anchors[0];
			if (!first || first.orphaned) continue;
			let at = blocks.findIndex((_, index) => room.matchesAnchor(plan.document, first, index));
			if (at < 0) continue;
			questions[question] = blocks.slice(0, at).flatMap((block, index) =>
				block.type === "heading" ? [room.anchorAt(plan.document, index, digests[index]!)] : []
			).toReversed();
		}
		out.set(record.id, questions);
	}
	return out;
}

/**
 * After a whole-document rewrite, keep the Planner's own cards linked, as a workflow's cards stay
 * linked to the sections they name. Such a rewrite runs outside any Planner turn, so a link it
 * left owing a review would never be reviewed. A block that survived keeps its card; a deleted
 * one hands it to the nearest heading above it that survived, else the first section. A write-up
 * whose passage was deleted has nothing left to rewrite, so it is dropped rather than failing.
 */
export function keepOwnLinked(plan: Plan, before: Sections): void {
	for (let [id, record] of plan.records) {
		if (!plannerOwn(record)) continue;
		let value = Anchors.read(record);
		let changed = false;
		for (let [question, set] of Object.entries(value.questions)) {
			if (!set.anchors.length) continue;
			let live = set.anchors.filter(anchor => !anchor.orphaned);
			let anchors = live;
			if (!live.length) {
				let heading = room.rebase(plan.document, before.get(id)?.[question] ?? [])
					.find(anchor => !anchor.orphaned);
				let first = heading ? undefined : room.firstSection(plan.document);
				let fallback = heading
					?? (first && room.anchorAt(plan.document, first.index, first.digest));
				if (!fallback) continue;
				anchors = [fallback];
			}
			value.questions[question] = { anchors, pending: false };
			changed = true;
		}
		let lost = record.followUp?.target.some(anchor => anchor.orphaned);
		if (!changed && !lost) continue;
		let { followUp, ...rest } = record;
		plan.records.set(id, {
			...rest,
			anchors: value,
			...(followUp && !lost ? { followUp } : {}),
		});
	}
}

/** Every decision's relationships as they stand, to compare with after an edit. */
export function snapshot(plan: Plan): Map<string, Wired.WidgetAnchors> {
	return new Map([...plan.records].map(([id, record]) => [id, Anchors.read(record)]));
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
	if (!record.definition.questions.some(value => value.id === question)) {
		return `no question ${question} in questionnaire ${widget}`;
	}

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
	let blocks = parse(room.project(plan.document)).children;
	let digests = room.digests(plan.document);

	for (let record of records) {
		let update = byWidget.get(record.id);
		if (!update || record.definition.questions.length !== 1 || update.blocks.length === 0) continue;

		let home = update.blocks[0]!;
		let at = home;
		if (digests[home.index] === home.digest && blocks[home.index]?.type === "paragraph") {
			for (let index = home.index + 1; index < blocks.length; index++) {
				let block = blocks[index]!;
				// Old placements may already have separated the paragraph from its visual.
				if (block.type === "mdxJsxFlowElement" && block.name === "Questionnaire") continue;
				if (
					block.type !== "table" && !(block.type === "code" && block.lang === SEECODE_LANGUAGE)
				) break;
				at = { index, digest: digests[index]! };
			}
		}
		let group = new Set([record.id]);
		if (at.index > home.index) {
			for (let peer of records) {
				let index = room.questionnaireIndex(plan.document, peer.id);
				let requested = byWidget.get(peer.id)?.blocks[0];
				if (
					index !== undefined && index > home.index && index < at.index
					&& (!requested || requested.index === home.index)
				) group.add(peer.id);
			}
		}
		for (let member of records.filter(candidate => group.has(candidate.id))) {
			let before = records.slice(0, records.indexOf(member)).findLast(candidate => {
				if (group.has(candidate.id)) return true;
				let index = room.questionnaireIndex(plan.document, candidate.id);
				if (index === undefined || index <= at.index) return false;
				if (candidate.definition.questions.length !== 1) return false;
				let question = candidate.definition.questions[0]!;
				let anchor = Anchors.read(candidate).questions[question.id]?.anchors[0];
				return anchor !== undefined && room.matchesAnchor(plan.document, anchor, home.index);
			});
			placements.push({ id: member.id, at, ...(before ? { after: before.id } : {}) });
		}
	}

	return room.placeQuestionnaires(plan.document, placements);
}
