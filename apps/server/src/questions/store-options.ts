import * as Question from "@chopin/question";

import type { DecisionDefinition, Definition, Model } from "@chopin/question";
import type { Open, Questions } from "./store-types";

export type AddedOption =
	| { ok: true; definition: DecisionDefinition; option: Question.Option; revision: number }
	| { ok: false; reason: "full" | "duplicate" | "invalid" | "closed"; message: string };

export type Retitled =
	| { ok: true; definition: DecisionDefinition; revision: number; applied: boolean }
	| { ok: false; reason: "invalid" | "closed"; message: string };

/** Change only the display label of an existing option; the draft keeps its option ID. */
export function relabelOption(
	questions: Questions,
	id: string,
	optionId: string,
	label: string,
	expectedRevision: number,
): { definition: DecisionDefinition; revision: number } {
	let entry = questions.open.get(id);
	if (!entry || entry.claim || entry.definition.questions.length !== 1) {
		throw new Error("decision is no longer open");
	}
	if (entry.revision !== expectedRevision) throw new Error("stale decision revision");
	let question = entry.definition.questions[0]!;
	let option = question.options.find(item => item.id === optionId);
	if (!option) throw new Error("unknown decision option");
	if (option.label === label) throw new Error("option label is unchanged");
	if (
		question.options.some(item =>
			item.id !== optionId
			&& item.label.trim().toLocaleLowerCase() === label.trim().toLocaleLowerCase()
		)
	) {
		throw new Error("duplicate option label");
	}
	let definition = Question.decision({
		questions: [{
			...question,
			options: question.options.map(item => item.id === optionId ? { ...item, label } : item),
		}],
	});
	Question.read(entry.model, definition);
	entry.definition = definition;
	entry.revision++;
	if (entry.suggested) entry.suggested = { ...entry.suggested, revision: entry.revision };
	return { definition, revision: entry.revision };
}

/** Reword one open decision while retaining its shared human draft. */
export function retitle(questions: Questions, id: string, text: string): Retitled {
	let entry = questions.open.get(id);
	if (!entry || entry.claim || entry.definition.questions.length !== 1) {
		return { ok: false, reason: "closed", message: "This decision is no longer open" };
	}
	let question = typeof text === "string" ? text.trim() : "";
	if (!question || question.length > Question.limits.MAX_QUESTION) {
		return { ok: false, reason: "invalid", message: "A question is 1–1000 characters" };
	}
	let current = entry.definition.questions[0]!;
	if (current.question === question) {
		return {
			ok: true,
			definition: Question.decision(entry.definition),
			revision: entry.revision,
			applied: false,
		};
	}
	let definition = Question.decision({ questions: [{ ...current, question }] });
	entry.definition = definition;
	entry.revision++;
	if (entry.suggested) entry.suggested = { ...entry.suggested, revision: entry.revision };
	return { ok: true, definition, revision: entry.revision, applied: true };
}

export type Before = {
	definition: Definition;
	model: Model;
	revision: number;
	suggested?: Open["suggested"];
};

/** Capture the three fields changed by an option addition. */
export function before(questions: Questions, id: string): Before | undefined {
	let entry = questions.open.get(id);
	return entry && {
		definition: entry.definition,
		model: entry.model,
		revision: entry.revision,
		...(entry.suggested ? { suggested: entry.suggested } : {}),
	};
}

/** Grow an open decision without changing a person's existing draft choice. */
export function addOption(
	questions: Questions,
	id: string,
	optionId: string,
	label: string,
): AddedOption {
	let entry = questions.open.get(id);
	if (!entry || entry.claim) {
		return { ok: false, reason: "closed", message: "This decision is no longer open" };
	}
	if (entry.definition.questions.length !== 1) {
		return {
			ok: false,
			reason: "closed",
			message: "Options cannot be added to this questionnaire",
		};
	}
	let outcome = Question.addOption(
		Question.decision(entry.definition),
		entry.model,
		optionId,
		label,
	);
	if (!outcome.ok) return outcome;
	entry.definition = outcome.definition;
	entry.model = outcome.model;
	entry.revision++;
	if (entry.suggested) entry.suggested = { ...entry.suggested, revision: entry.revision };
	return {
		ok: true,
		definition: outcome.definition,
		option: outcome.option,
		revision: entry.revision,
	};
}

/** Restore the original shape if a caller discards an uncommitted addition. */
export function revert(questions: Questions, id: string, previous: Before): void {
	let entry = questions.open.get(id);
	if (!entry) return;
	entry.definition = previous.definition;
	entry.model = previous.model;
	entry.revision = previous.revision;
	entry.suggested = previous.suggested;
}

/** Keep draft edits and resolution claims off a card during its fenced option commit. */
export function reserveOption(questions: Questions, id: string): boolean {
	let entry = questions.open.get(id);
	if (!entry || entry.claim) return false;
	entry.claim = "option";
	return true;
}

export function releaseOption(questions: Questions, id: string): void {
	let entry = questions.open.get(id);
	if (entry?.claim === "option") entry.claim = undefined;
}

/** Hold a draft while its edit is fenced, so no submit reads uncommitted state. */
export function reserveEdit(questions: Questions, id: string): boolean {
	let entry = questions.open.get(id);
	if (!entry || entry.claim) return false;
	entry.claim = "edit";
	return true;
}

export function releaseEdit(questions: Questions, id: string): void {
	let entry = questions.open.get(id);
	if (entry?.claim === "edit") entry.claim = undefined;
}
