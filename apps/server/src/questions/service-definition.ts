import { ulid } from "@chopin/dialect";
import * as Question from "@chopin/question";

import * as room from "../plan/room";

import type { Plan as Wired } from "@chopin/protocol";
import type { Answer, Definition } from "@chopin/question";

import type { Plan } from "../plan/service";

// Exact archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2 declarations; import/export wrappers only.
export type AskPlacement = {
	revision: number;
	blocks: Array<Array<{ index: number; digest: string }>>;
};

export function identify(raw: unknown, options?: { verbatim?: boolean }): Definition {
	let definition = Question.normalize(raw, options);
	return {
		questions: definition.questions.map(question => ({
			...question,
			id: ulid(),
			options: question.options.map(option => ({ ...option, id: ulid() })),
		})),
	};
}

export function decide(
	entry: { status: "answered"; answers: Answer[] } | { status: "cancelled" },
	definition: Definition,
): { [question: string]: string } {
	if (entry.status !== "answered") return {};
	let out: { [question: string]: string } = {};
	definition.questions.forEach((question, index) => {
		let answer = entry.answers[index];
		if (answer) out[question.id] = Question.summarize(answer);
	});
	return out;
}

export function validatePlacement(
	plan: Plan,
	definition: Definition,
	placement: AskPlacement,
): Wired.Anchor[][] {
	if (placement.revision !== plan.revision) {
		throw new Error("The plan changed; read it again before asking.");
	}
	if (placement.blocks.length !== definition.questions.length) {
		throw new Error("Give one placement for every question.");
	}

	let digests = room.digests(plan.document);
	return placement.blocks.map(blocks => {
		if (blocks.length === 0) {
			if (room.hasProse(plan.document)) {
				throw new Error("Relate each question to prose, or write its context first.");
			}
			return [];
		}

		return blocks.map(block => {
			let current = digests[block.index];
			if (!current) throw new Error(`no block at index ${block.index}`);
			if (current !== block.digest) {
				throw new Error(`block ${block.index} has changed; read the plan again`);
			}
			return room.anchorAt(plan.document, block.index, current);
		});
	});
}
