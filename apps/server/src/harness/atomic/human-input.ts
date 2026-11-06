import * as Questions from "../../questions/service";

import type {
	HostInput,
	HostInputOptions,
	QuestionAnswer,
	QuestionnaireResult,
	QuestionParams,
} from "@bastani/atomic";
import type { DocumentRoom } from "../../agent/tools";
import type { Plan } from "../../plan/service";
import type { Ended } from "../../questions/store";

export type HumanInputStatus = "answered" | "cancelled";

/** The kinds of host input request, as a client names them. */
export type InputMethod = "questionnaire" | "confirm" | "select" | "input" | "editor";

/**
 * A request waiting on the document's members, as a restart keeps it: the kind it was and the
 * decisions it asked, which is what its client needs to be given the answer again.
 */
export type AskedInput = { method: InputMethod; decisions: string[] };

/**
 * A host input request's options, with the block it concerns: its `index` and `digest` from the
 * Planner's latest read of the document. Its card goes beside that block and is linked to it; a
 * changed or repeated block leaves the card unlinked at the end of the document. `asked` hears the
 * ids of the decisions the request created, once they exist.
 */
export type HumanInputOptions = HostInputOptions & {
	block?: { index: number; digest: string };
	asked?: (decisions: string[]) => void;
};

/**
 * The requests a Planner session has made that are still waiting on the document's members,
 * and the requests whose result its client has not received. A session that has either must
 * outlive the turn that ended while it waited: letting it go would withdraw a question nobody
 * has answered, or take an answer away from the client that asked for it.
 */
export class PendingInputs {
	#open = 0;
	#held = 0;
	#listeners = new Set<() => void>();

	/** How many requests are waiting on a member's answer. */
	open(): number {
		return this.#open;
	}

	/** How many requests have not yet given their client a result, answered or not. */
	held(): number {
		return this.#held;
	}

	/** Calls `listener` whenever a request ends or its result is delivered; returns the unsubscribe function. */
	watch(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** Counts one request from now until `work` settles. */
	async track<T>(work: Promise<T>): Promise<T> {
		this.#open++;
		try {
			return await work;
		} finally {
			this.#open--;
			this.#notify();
		}
	}

	/**
	 * Counts one request from now until the returned function is called: when its result has
	 * reached the client, or never can. A request that settles is no longer waiting, but its
	 * session still owes the client that result. Calling it again does nothing.
	 */
	hold(): () => void {
		this.#held++;
		let held = true;
		return () => {
			if (!held) return;
			held = false;
			this.#held--;
			this.#notify();
		};
	}

	#notify(): void {
		for (let listener of this.#listeners) {
			try {
				listener();
			} catch (error) {
				console.error("[agent] a pending input watcher failed:", error);
			}
		}
	}
}

/**
 * What a client is given for the decisions its request asked, once each has ended: a
 * questionnaire's answers and whether any was cancelled, in the words Atomic's own dialog uses.
 */
function resultOf(params: QuestionParams, ended: Ended[]): QuestionnaireResult {
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

/** The single answer of a one-question request, unless it was cancelled. */
function answerOf(result: QuestionnaireResult): QuestionAnswer | undefined {
	return result.cancelled ? undefined : result.answers[0];
}

/** What each kind of request hands its client from its questionnaire's result. */
function valueOf(method: InputMethod, result: QuestionnaireResult, choices: string[]): unknown {
	if (method === "questionnaire") return result;
	let answer = answerOf(result);
	if (method === "confirm") return answer?.kind === "option" && answer.answer === "Yes";
	if (method === "select") {
		return answer?.kind === "option" && answer.answer !== null && choices.includes(answer.answer)
			? answer.answer
			: undefined;
	}
	return answer?.kind === "custom" ? answer.answer ?? undefined : undefined;
}

/** The params of a request that asks one question with these choices. */
function single(header: string, question: string, choices: string[]): QuestionParams {
	return {
		questions: [{
			header,
			question,
			options: choices.map(label => ({ label, description: "" })),
		}],
	};
}

/** The questions a request asked, as its decisions' own definitions say them. */
function paramsOf(plan: Plan, decisions: string[]): QuestionParams {
	return {
		questions: decisions.map(id => {
			let record = plan.records.get(id);
			let question = record?.definition.questions[0];
			if (!record || !question) return { header: "", question: "", options: [] };
			// An option a member added was never offered by the asker.
			let appended = new Set(Object.values(record.appended ?? {}));
			return {
				header: question.header,
				question: question.question,
				options: question.options.filter(option => !appended.has(option.id)).map(option => ({
					label: option.label,
					description: option.description ?? "",
					...(option.preview ? { preview: option.preview } : {}),
				})),
				multiSelect: question.multiple,
			};
		}),
	};
}

/**
 * Waits again for the answer to a request a process that has since restarted left open, for the
 * client that asked it and is coming back, and gives that client what it would have been given:
 * the same result as the process that asked it would have sent, from the decisions it created.
 */
export async function rejoinInput(
	room: Pick<DocumentRoom, "plan" | "server" | "id">,
	asked: AskedInput,
	signal: AbortSignal,
): Promise<{ status: HumanInputStatus; value: unknown }> {
	let params = paramsOf(room.plan, asked.decisions);
	let ended = await Questions.rejoin(room.plan, room.server, room.id, asked.decisions, signal);
	let result = signal.aborted ? { answers: [], cancelled: true } : resultOf(params, ended);
	return {
		status: result.cancelled ? "cancelled" : "answered",
		value: valueOf(
			asked.method,
			result,
			params.questions[0]?.options.map(option => option.label) ?? [],
		),
	};
}

/** Chopin's HostInput, whose methods also take the block a request concerns. */
export type HumanInput = {
	[Method in keyof HostInput]: HostInput[Method] extends (...args: infer A) => infer R
		? (...args: { [K in keyof A]: A[K] extends HostInputOptions ? HumanInputOptions : A[K] }) => R
		: never;
};

/**
 * Atomic owns input requests; Chopin owns their shared decision records.
 *
 * A request has no time limit: it waits until a member answers it or it is
 * withdrawn, as when its Planner stops, its run is cancelled, or its link
 * closes. An answer to a workflow
 * question is returned only once `hold` allows it, so a paused run stays stopped.
 * `report` learns how each request ended, which the cancelled result alone
 * cannot tell apart.
 */
export function createHumanInput(
	room: DocumentRoom,
	hold?: (workflowRunId: string, signal: AbortSignal) => Promise<void>,
	report?: (status: HumanInputStatus) => void,
	pending?: PendingInputs,
): HumanInput {
	const questionnaire = (params: QuestionParams, options: HumanInputOptions) =>
		pending ? pending.track(asking(params, options)) : asking(params, options);
	async function asking(
		params: QuestionParams,
		options: HumanInputOptions,
	): Promise<QuestionnaireResult> {
		if (options.signal.aborted || room.focusedChild?.() || room.plan.chat?.actingChannel) {
			report?.("cancelled");
			return { answers: [], cancelled: true };
		}
		let definition = Questions.identify({
			questions: params.questions.map(question => ({
				header: question.header,
				question: question.question,
				options: question.options.map(option => ({
					label: option.label,
					description: option.description,
					// The option's own visual (a diagram, a table, an image of this document's)
					// is its own field: every card surface frames it under the option.
					...(option.preview ? { preview: option.preview } : {}),
				})),
				multiple: question.multiSelect ?? false,
			})),
		}, { verbatim: true });
		let ended = await Questions.ask(
			room.plan,
			room.server,
			room.id,
			definition,
			options.block ? { near: options.block } : undefined,
			room.anchors,
			options.signal,
			options.asked,
		);
		if (options.signal.aborted) {
			report?.("cancelled");
			return { answers: [], cancelled: true };
		}
		if (hold && options.workflowRunId !== undefined) {
			await hold(options.workflowRunId, options.signal);
			if (options.signal.aborted) {
				report?.("cancelled");
				return { answers: [], cancelled: true };
			}
		}
		let result = resultOf(params, ended);
		report?.(result.cancelled ? "cancelled" : "answered");
		return result;
	}
	return {
		questionnaire,
		async confirm(title, message, options) {
			let params = single("Confirm", `${title}\n\n${message}`, ["Yes", "No"]);
			return valueOf("confirm", await questionnaire(params, options), []) as boolean;
		},
		async select(title, choices, options) {
			let result = await questionnaire(single("Select", title, choices), options);
			return valueOf("select", result, choices) as string | undefined;
		},
		async input(title, placeholder, options) {
			let question = [title, placeholder].filter(value => value !== undefined).join("\n\n");
			let result = await questionnaire(single("Input", question, []), options);
			return valueOf("input", result, []) as string | undefined;
		},
		async editor(title, initial, options) {
			let question = [title, initial].filter(value => value !== undefined).join("\n\n");
			let result = await questionnaire(single("Editor", question, []), options);
			return valueOf("editor", result, []) as string | undefined;
		},
	};
}
