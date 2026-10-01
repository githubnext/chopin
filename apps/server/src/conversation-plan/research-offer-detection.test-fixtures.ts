import { expect } from "bun:test";
import type { Chat, ConversationPlan } from "@chopin/protocol";
import { initialState } from "./domain";
import type { Effect } from "./effects";
import { applyEvent } from "./events";
import { interpretMessage } from "./interpret";
import type { JevAnswer, JevQuestion, JevRequest, JevResult } from "./jev";
import { createProcessor, type Dependencies } from "./service";

// Whole archived detection fixture declarations; export modifiers only.
export type Member = Extract<Chat.Author, { kind: "member" }>;

export type Override = string | number | JevAnswer;

export let ada: Member = { kind: "member", handle: "ada" };

export let postmarkId = "01K00000000000000000000011";

export let sesId = "01K00000000000000000000012";

export let s3Id = "01K00000000000000000000013";

export let r2Id = "01K00000000000000000000014";

export let resendId = "01K00000000000000000000015";

export let relayId = "01K00000000000000000000016";

export let sharedDiskId = "01K00000000000000000000017";

export let relayCopyId = "01K00000000000000000000018";

export let postmarkCopyId = "01K00000000000000000000019";

export let sesCopyId = "01K0000000000000000000001A";

export function entry(id: string, text: string, ts = 1): Chat.Entry {
	return { id, text, ts, author: ada };
}

export function seededThread(
	threadId: string,
	question: string,
	options: Array<{ id: string; text: string }>,
	status: "open" | "decided" = "open",
): ConversationPlan.State {
	let state = applyEvent(initialState(), {
		id: `open-${threadId}`,
		type: "thread.opened",
		threadId,
		observedThreadVersion: 0,
		origin: "planner",
		actor: { kind: "agent" },
		at: 1,
		question,
	});
	for (let option of options) {
		state = applyEvent(state, {
			id: `add-${option.id}`,
			type: "option.added",
			threadId,
			observedThreadVersion: state.threads[0]!.version,
			origin: "planner",
			actor: { kind: "agent" },
			at: state.events.length + 1,
			contribution: { id: option.id, text: option.text, authoring: "scribe" },
		});
	}
	state = applyEvent(state, {
		id: `link-${threadId}`,
		type: "card.linked",
		threadId,
		observedThreadVersion: state.threads[0]!.version,
		origin: "classifier",
		actor: { kind: "classifier" },
		at: state.events.length + 1,
		questionnaireId: `card-${threadId}`,
	});
	if (status === "decided") {
		state = applyEvent(state, {
			id: `decide-${threadId}`,
			type: "decision.recorded",
			threadId,
			observedThreadVersion: state.threads[0]!.version,
			origin: "human",
			actor: ada,
			at: state.events.length + 1,
			text: `Use ${options[0]!.text}`,
			optionId: options[0]!.id,
			explicit: true,
		});
	}
	return state;
}

export function d03Options(threadId = "mail") {
	return seededThread(threadId, "Which email delivery service should we use?", [
		{ id: relayId, text: "SMTP relay" },
		{ id: postmarkId, text: "Postmark" },
		{ id: sesId, text: "Amazon SES" },
	]);
}

export function d04Options(threadId = "storage") {
	return seededThread(threadId, "Where should uploaded images live?", [
		{ id: s3Id, text: "Amazon S3" },
		{ id: sharedDiskId, text: "shared disk" },
		{ id: r2Id, text: "Cloudflare R2" },
	]);
}

export function answerResult(
	questions: Record<string, JevQuestion>,
	overrides: Record<string, Override> = {},
): JevResult {
	let answers: Record<string, JevAnswer> = {};
	for (let [key, question] of Object.entries(questions)) {
		let override = overrides[key];
		if (question.type === "noul") {
			answers[key] = override && typeof override === "object"
				? override
				: { type: "noul", noul: typeof override === "number" ? override : 0.05 };
		} else if (question.type === "choice") {
			if (override && typeof override === "object") {
				answers[key] = override;
				continue;
			}
			let choices = Object.keys(question.criteria);
			let choice = typeof override === "string" && choices.includes(override)
				? override
				: choices.includes("none")
				? "none"
				: choices[0]!;
			let remainder = (1 - 0.95) / Math.max(choices.length - 1, 1);
			answers[key] = {
				type: "choice",
				choice,
				confidence: 0.95,
				probabilities: Object.fromEntries(
					choices.map(item => [item, item === choice ? 0.95 : remainder]),
				),
			};
		} else {
			let levels = question.criteria;
			answers[key] = {
				type: "score",
				score: 0,
				confidence: 1,
				legend: Object.fromEntries(levels.map((label, index) => [String(index), label])),
				probabilities: Object.fromEntries(
					levels.map((_, index) => [String(index), index === 0 ? 1 : 0]),
				),
			};
		}
	}
	return { model: "fake-jev", answers, usage: { input_tokens: 1, output_tokens: 1 }, latencyMs: 1 };
}

export type ResearchJudgment = {
	threadId: string;
	optionIds: string[];
	quote: string;
	kind?: "current-cost-comparison" | "current-cost-concern";
	scopeChoice?: string;
	scopeAnswer?: JevAnswer;
	threadAnswer?: JevAnswer;
	need?: number;
	triageOwned?: number;
	owned?: number;
	answered?: number;
	quoteChoice?: string;
	optionAAnswer?: JevAnswer;
};

export function fakeJev(judgment: ResearchJudgment) {
	return async (request: JevRequest): Promise<JevResult> => {
		let overrides: Record<string, Override> = {};
		if ("research_need" in request.questions) {
			overrides.research_need = judgment.need ?? 0.95;
			for (let key of Object.keys(request.questions)) {
				if (key.endsWith("_owned_unretracted")) {
					overrides[key] = judgment.triageOwned ?? 0.95;
				}
			}
		} else if ("research_quote" in request.questions) {
			let quoteQuestion = request.questions.research_quote;
			let quoteChoices = quoteQuestion?.type === "choice" ? quoteQuestion.criteria : {};
			overrides.research_quote = judgment.quoteChoice
				?? Object.entries(quoteChoices).find(([, description]) => description === judgment.quote)
					?.[0]
				?? "none";
			overrides.research_thread = judgment.threadAnswer ?? judgment.threadId;
			overrides.research_option_a = judgment.optionAAnswer
				?? (judgment.kind === "current-cost-concern" ? "none" : judgment.optionIds[0]);
			overrides.research_option_b = judgment.kind === "current-cost-concern"
				? "none"
				: judgment.optionIds[1];
			overrides.research_kind = judgment.kind ?? "current-cost-comparison";
			let quoteKey = overrides.research_quote;
			let scopeKey = typeof quoteKey === "string" ? `research_${quoteKey}_scope` : "";
			if (judgment.kind === "current-cost-concern" && scopeKey in request.questions) {
				overrides[scopeKey] = judgment.scopeAnswer ?? judgment.scopeChoice ?? "all-current";
			}
			let ownerQuestion = typeof overrides.research_quote === "string"
				? `research_${overrides.research_quote}_owned`
				: "research_q0_owned";
			overrides[ownerQuestion] = judgment.owned ?? 0.95;
			let answeredQuestion = typeof overrides.research_quote === "string"
				? `research_${overrides.research_quote}_answered`
				: "research_q0_answered";
			overrides[answeredQuestion] = judgment.answered ?? 0.05;
		}
		return answerResult(request.questions, overrides);
	};
}

export function inputInterpreter(judgmentFor: (message: Chat.Entry) => ResearchJudgment) {
	return (input: Parameters<NonNullable<Dependencies["interpret"]>>[0]) =>
		interpretMessage({ ...input, ask: fakeJev(judgmentFor(input.message)) });
}

export function detectResearchOffer(
	state: ConversationPlan.State,
	message: Chat.Entry,
	judgment: ResearchJudgment,
) {
	return interpretMessage({
		channelId: "channel",
		message,
		recent: [],
		state,
		ask: fakeJev(judgment),
	});
}

export function harness(
	state: ConversationPlan.State,
	interpret: NonNullable<Dependencies["interpret"]>,
	entries: Chat.Entry[] = [],
) {
	let plan = {
		id: "channel",
		chat: { entries: [...entries] },
		conversationPlan: state,
		conversationPlanRetries: [],
		conversationPlanEffects: [] as string[],
		conversationPlanPendingEffects: [] as Effect[],
		pendingCardActions: [],
		records: new Map(),
	} as unknown as Dependencies["plan"];
	let durable = structuredClone({
		entries: plan.chat.entries,
		state: plan.conversationPlan,
		pending: plan.conversationPlanPendingEffects,
		receipts: plan.conversationPlanEffects,
	});
	let publications: ConversationPlan.State[] = [];
	let errors: unknown[] = [];
	let persistCount = 0;
	let failAt: number | undefined;
	let tail = Promise.resolve();
	let dependencies: Dependencies = {
		plan,
		exclusive: action => {
			let operation = tail.then(action, action);
			tail = operation.then(() => {}, () => {});
			return operation;
		},
		persist: async () => {
			persistCount++;
			if (persistCount === failAt) throw new Error("storage failed");
			durable = structuredClone({
				entries: plan.chat.entries,
				state: plan.conversationPlan,
				pending: plan.conversationPlanPendingEffects,
				receipts: plan.conversationPlanEffects,
			});
		},
		publish: next => {
			expect(durable.state).toEqual(next);
			publications.push(structuredClone(next));
		},
		active: () => true,
		interpret,
		onError: error => errors.push(error),
	};
	return {
		plan,
		dependencies,
		processor: createProcessor(dependencies),
		publications,
		errors,
		get durable() {
			return durable;
		},
		get persistCount() {
			return persistCount;
		},
		failPersistenceAfter(offset: number) {
			failAt = persistCount + offset;
		},
	};
}

export async function waitFor(condition: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 400; attempt++) {
		if (condition()) return;
		await Bun.sleep(1);
	}
	throw new Error("processor did not reach the expected state");
}

export async function processMessage(
	setup: ReturnType<typeof harness>,
	message: Chat.Entry,
): Promise<void> {
	await setup.processor.accept(message);
	setup.processor.afterMessage();
	await waitFor(() =>
		setup.errors.length > 0 || setup.durable.state.analysis.some(
			item => item.messageId === message.id,
		)
	);
}

export function exactSource(message: Chat.Entry, quote: string): ConversationPlan.ResearchSource {
	let start = message.text.indexOf(quote);
	if (start < 0) throw new Error("quote missing from synthetic message");
	return {
		messageId: message.id,
		author: message.author as ConversationPlan.SourceAuthor,
		quote,
		start,
		end: start + quote.length,
	};
}

export async function expectNoDurableOffer(
	state: ConversationPlan.State,
	message: Chat.Entry,
	judgment: ResearchJudgment,
): Promise<void> {
	let setup = harness(state, inputInterpreter(() => judgment));
	await processMessage(setup, message);
	expect(setup.durable.state.researchOffers ?? []).toEqual([]);
	expect(setup.durable.state.analysis.some(item => item.messageId === message.id)).toBe(true);
	setup.processor.stop();
}
