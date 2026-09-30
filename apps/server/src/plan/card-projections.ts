import { $nodesOfType } from "lexical";
import { QuestionnaireNode } from "@chopin/dialect";
import type { Previous } from "@chopin/dialect";
import type * as Question from "@chopin/question";
import type { Document, Mutation } from "./room";

export type CardChange = {
	status: "open" | "decided" | "reopened" | "discarded";
	clearAnswers?: boolean;
	previous?: { [question: string]: Previous | null };
};

export class QuestionnaireProjectionError extends Error {}

export function createCardProjections(
	mutate: (target: Document, change: () => boolean) => Mutation | undefined,
) {
	function projectAnswer(
		target: Document,
		id: string,
		answers: Record<string, string>,
		settled?: { by: string; at: string },
		chosen?: Record<string, string[]>,
	): Mutation | undefined {
		return mutate(target, () => {
			let matches = $nodesOfType(QuestionnaireNode).filter(node => node.getId() === id);
			if (matches.length !== 1) throw new QuestionnaireProjectionError("Card is not available");
			let node = matches[0]!;
			let value = node.getQuestionnaire();
			let known = new Set(value.questions.map(question => question.id));
			if (
				known.size !== value.questions.length
				|| known.size !== Object.keys(answers).length
				|| Object.keys(answers).some(question => !known.has(question))
				|| Object.keys(chosen ?? {}).some(question => !known.has(question))
			) throw new QuestionnaireProjectionError("Card questions do not match its record");
			node.setQuestionnaire({
				...value,
				// Resolution belongs to the questionnaire, not each answer.
				...(settled ? { by: settled.by, at: settled.at, status: "decided" as const } : {}),
				questions: value.questions.map(question => {
					let answer = answers[question.id];
					if (answer === undefined) return question;
					let projected = { ...question, answer };
					let ids = chosen?.[question.id];
					if (ids?.length) projected.choices = ids;
					else delete projected.choices;
					return projected;
				}),
			});
			return true;
		});
	}

	function projectCard(
		target: Document,
		id: string,
		change: CardChange,
	): Mutation | undefined {
		return mutate(target, () => {
			let matches = $nodesOfType(QuestionnaireNode).filter(node => node.getId() === id);
			if (matches.length !== 1) throw new QuestionnaireProjectionError("Card is not available");
			let node = matches[0]!;
			let value = node.getQuestionnaire();
			let known = new Set(value.questions.map(question => question.id));
			if (
				known.size !== value.questions.length
				|| Object.keys(change.previous ?? {}).some(question => !known.has(question))
			) throw new QuestionnaireProjectionError("Card questions do not match its record");
			let { by: _by, at: _at, ...unsettled } = value;
			node.setQuestionnaire({
				...(change.clearAnswers ? unsettled : value),
				status: change.status,
				questions: value.questions.map(question => {
					let next = { ...question };
					if (change.clearAnswers) {
						delete next.answer;
						delete next.choices;
					}
					let previous = change.previous?.[question.id];
					if (previous === null) delete next.previous;
					else if (previous) next.previous = previous;
					return next;
				}),
			});
			return true;
		});
	}

	function hasQuestionnaire(target: Document, id: string, questionId: string): boolean {
		return target.editor.getEditorState().read(() => {
			let matches = $nodesOfType(QuestionnaireNode).filter(node => node.getId() === id);
			if (matches.length !== 1) return false;
			let questions = matches[0]!.getQuestionnaire().questions;
			return questions.length === 1 && questions[0]?.id === questionId;
		});
	}

	function projectOptions(
		target: Document,
		id: string,
		question: Question.Item,
	): Mutation | undefined {
		return mutate(target, () => {
			let matches = $nodesOfType(QuestionnaireNode).filter(node => node.getId() === id);
			if (matches.length !== 1) throw new QuestionnaireProjectionError("Card is not available");
			let node = matches[0]!;
			let value = node.getQuestionnaire();
			if (value.questions.filter(item => item.id === question.id).length !== 1) {
				throw new QuestionnaireProjectionError("Card question does not match its record");
			}
			node.setQuestionnaire({
				...value,
				questions: value.questions.map(item =>
					item.id !== question.id ? item : {
						...item,
						options: question.options.map(option => ({
							id: option.id,
							label: option.label,
							...(option.description ? { description: option.description } : {}),
						})),
					}
				),
			});
			return true;
		});
	}

	function projectPrompt(
		target: Document,
		id: string,
		questionId: string,
		prompt: string,
	): Mutation | undefined {
		return mutate(target, () => {
			let matches = $nodesOfType(QuestionnaireNode).filter(node => node.getId() === id);
			if (matches.length !== 1) throw new QuestionnaireProjectionError("Card is not available");
			let node = matches[0]!;
			let value = node.getQuestionnaire();
			if (value.questions.length !== 1 || value.questions[0]?.id !== questionId) {
				throw new QuestionnaireProjectionError("Card question does not match its record");
			}
			node.setQuestionnaire({
				...value,
				questions: [{ ...value.questions[0]!, prompt }],
			});
			return true;
		});
	}

	return { projectAnswer, projectCard, hasQuestionnaire, projectOptions, projectPrompt };
}
