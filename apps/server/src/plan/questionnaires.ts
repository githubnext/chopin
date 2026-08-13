import { $createQuestionnaireNode, QuestionnaireNode } from "@chopin/dialect";
import { $getRoot, $isParagraphNode, $nodesOfType } from "lexical";

import type { Questionnaire } from "@chopin/dialect";
import type { LexicalNode } from "lexical";
import type { Mutation } from "./room";

export type BlockAddress = { index: number; digest: string };

export type QuestionnaireInsertion = {
	value: Questionnaire;
	at?: BlockAddress;
};

export type QuestionnairePlacement = {
	id: string;
	at: BlockAddress;
	after?: string;
};

type Actions = {
	digests: () => string[];
	mutate: (change: () => boolean) => Mutation | undefined;
};

function addressable(): LexicalNode[] {
	return $getRoot().getChildren().filter(
		node => !($isParagraphNode(node) && node.getChildrenSize() === 0),
	);
}

function validate(actions: Actions, placements: Array<{ at: BlockAddress }>): void {
	let hashes = actions.digests();
	for (let { at } of placements) {
		let current = hashes[at.index];
		if (!current) throw new Error(`no block at index ${at.index}`);
		if (current !== at.digest) {
			throw new Error(`block ${at.index} has changed; read the plan again`);
		}
	}
}

/** Insert one ask batch directly after its validated prose. */
export function insert(
	actions: Actions,
	insertions: QuestionnaireInsertion[],
): Mutation | undefined {
	validate(
		actions,
		insertions.filter((insertion): insertion is QuestionnaireInsertion & { at: BlockAddress } =>
			insertion.at !== undefined
		),
	);

	return actions.mutate(() => {
		let root = $getRoot();
		let blocks = addressable();
		let last = new Map<number, LexicalNode>();

		for (let insertion of insertions) {
			let questionnaire = $createQuestionnaireNode(insertion.value);
			if (!insertion.at) {
				root.append(questionnaire);
				continue;
			}

			let prose = blocks[insertion.at.index];
			if (!prose) throw new Error(`no block at index ${insertion.at.index}`);
			let previous = last.get(insertion.at.index) ?? prose;
			previous.insertAfter(questionnaire);
			last.set(insertion.at.index, questionnaire);
		}

		return insertions.length > 0;
	});
}

/** Move questionnaire cards directly after the prose their decisions address. */
export function place(
	actions: Actions,
	placements: QuestionnairePlacement[],
): Mutation | undefined {
	validate(actions, placements);

	return actions.mutate(() => {
		let blocks = addressable();
		let questionnaires = new Map(
			$nodesOfType(QuestionnaireNode).map(node => [node.getId(), node]),
		);
		let changed = false;

		for (let placement of placements) {
			let questionnaire = questionnaires.get(placement.id);
			// Restored records can outlive their decorator nodes; leave them in history.
			if (!questionnaire) continue;

			let prose = blocks[placement.at.index];
			if (!prose) throw new Error(`no block at index ${placement.at.index}`);
			let previous = placement.after ? questionnaires.get(placement.after) ?? prose : prose;
			if (questionnaire === previous || questionnaire.getPreviousSibling() === previous) continue;

			questionnaire.remove();
			previous.insertAfter(questionnaire);
			changed = true;
		}

		return changed;
	});
}
