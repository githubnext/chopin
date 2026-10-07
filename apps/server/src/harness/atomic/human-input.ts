import { limits } from "@chopin/question";

import * as Questions from "../../questions/service";

import type {
	HostInput,
	HostInputOptions,
	QuestionAnswer,
	QuestionnaireResult,
	QuestionParams,
} from "@bastani/atomic";
import type { DocumentRoom } from "../../agent/tools";

/**
 * Atomic owns input requests; Chopin owns their shared decision records.
 *
 * A request nobody answers within `expiresInMs` expires: its cards stay in
 * Decisions marked expired, and Atomic gets no answer. An answer to a workflow
 * question is returned only once `hold` allows it, so a paused run stays stopped.
 */
export function createHumanInput(
	room: DocumentRoom,
	expiresInMs = limits.INPUT_EXPIRY_MS,
	hold?: (workflowRunId: string, signal: AbortSignal) => Promise<void>,
): HostInput {
	async function questionnaire(
		params: QuestionParams,
		options: HostInputOptions,
	): Promise<QuestionnaireResult> {
		if (options.signal.aborted) return { answers: [], cancelled: true };
		let definition = Questions.identify({
			questions: params.questions.map(question => ({
				header: question.header,
				question: question.question,
				options: question.options.map(option => ({
					label: option.label,
					// Decisions shows no preview pane, so the mockup or code a member
					// needs to see before choosing travels in the description.
					description: [option.description, option.preview]
						.filter(value => value !== undefined)
						.join("\n\n"),
				})),
				multiple: question.multiSelect ?? false,
			})),
		}, { verbatim: true });
		let ended = await Questions.ask(
			room.plan,
			room.server,
			room.id,
			definition,
			undefined,
			room.anchors,
			options.signal,
			expiresInMs,
		);
		if (options.signal.aborted || ended.some(outcome => outcome.status === "expired")) {
			return { answers: [], cancelled: true };
		}
		if (hold && options.workflowRunId !== undefined) {
			await hold(options.workflowRunId, options.signal);
			if (options.signal.aborted) return { answers: [], cancelled: true };
		}
		let answers: QuestionAnswer[] = [];
		ended.forEach((outcome, questionIndex) => {
			if (outcome.status !== "answered") return;
			let answer = outcome.answers[0]!;
			let question = params.questions[questionIndex]!;
			let identity = { questionIndex, question: question.question };
			// Atomic accepts `custom` only where its own dialog offers a typed row.
			let typed = !question.multiSelect && !question.options.some(option => option.preview);
			let offered = new Set(question.options.map(option => option.label));
			let choices = answer.choices ?? [];
			// A member writes an answer by adding an option, which Atomic never offered.
			let written = answer.custom
				|| (choices.some(label => !offered.has(label)) ? choices.join(", ") : undefined);
			if (written !== undefined) {
				answers.push({ ...identity, kind: typed ? "custom" : "chat", answer: written });
			} else if (question.multiSelect) {
				answers.push({ ...identity, kind: "multi", answer: null, selected: choices });
			} else {
				let label = choices[0]!;
				let preview = question.options.find(option => option.label === label)?.preview;
				answers.push({
					...identity,
					kind: "option",
					answer: label,
					...(preview === undefined ? {} : { preview }),
				});
			}
		});
		return { answers, cancelled: ended.some(outcome => outcome.status === "cancelled") };
	}
	async function single(
		header: string,
		question: string,
		choices: string[],
		options: HostInputOptions,
	) {
		let result = await questionnaire({
			questions: [{
				header,
				question,
				options: choices.map(label => ({ label, description: "" })),
			}],
		}, options);
		return result.cancelled ? undefined : result.answers[0];
	}
	return {
		questionnaire,
		async confirm(title, message, options) {
			let answer = await single("Confirm", `${title}\n\n${message}`, ["Yes", "No"], options);
			return answer?.kind === "option" && answer.answer === "Yes";
		},
		async select(title, choices, options) {
			let answer = await single("Select", title, choices, options);
			return answer?.kind === "option" && answer.answer !== null && choices.includes(answer.answer)
				? answer.answer
				: undefined;
		},
		async input(title, placeholder, options) {
			let answer = await single(
				"Input",
				[title, placeholder].filter(value => value !== undefined).join("\n\n"),
				[],
				options,
			);
			return answer?.kind === "custom" ? answer.answer ?? undefined : undefined;
		},
		async editor(title, initial, options) {
			let answer = await single(
				"Editor",
				[title, initial].filter(value => value !== undefined).join("\n\n"),
				[],
				options,
			);
			return answer?.kind === "custom" ? answer.answer ?? undefined : undefined;
		},
	};
}
