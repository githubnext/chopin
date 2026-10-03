import { afterEach } from "bun:test";

import { cardEffects } from "./cards";
import { runEffects } from "./effects";
import { effectsFor } from "./effects";
import { initialState } from "./domain";
import { applyEvent } from "./events";
import * as Questions from "../questions/service";

import * as Service from "../plan/service";
import { openPlan } from "../testing/plan";
import type { ConversationPlan } from "@chopin/protocol";
import type { Plan } from "../plan/service";

import type { Processor } from "./service";

// Exact archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2 helpers and cleanup.
export const CARD = "01K0N4W3B7P27CBAEC7A8C8WEA";

export const OPTION = "01K0N4W3B7P27CBAEC7A8C8WEB";

export let plans: Plan[] = [];

afterEach(async () => {
	for (let plan of plans) await Service.close(plan);
	plans = [];
});

export function thread(
	status: ConversationPlan.Thread["status"] = "exploring",
): ConversationPlan.Thread {
	return {
		id: "thread-a",
		question: "Which auth system?",
		questionSources: [],
		questionAuthoring: "quoted",
		status,
		contributions: [{
			id: OPTION,
			kind: "option",
			text: "GitHub Apps",
			authoring: "quoted",
			sources: [],
			actor: { kind: "classifier" },
		}],
		stances: [],
		stanceHistory: [],
		decisionHistory: [],
		candidates: [],
		version: 4,
	};
}

export function base() {
	return { cardId: CARD, threadId: "thread-a", actor: "ana", at: 9 };
}

export function cardSource(
	messageId: string,
	handle: string,
	role: "resolution" | "support" | "objection",
) {
	return {
		messageId,
		author: { kind: "member" as const, handle },
		quote: messageId,
		start: 0,
		end: messageId.length,
		role,
	};
}

export async function scopedNoticeFixture(withAgreement: boolean) {
	let context = await openPlan();
	plans.push(context.plan);
	let id = await Questions.insertConversationCard(context.plan, context.server, "test", {
		threadId: "thread-a",
		header: "Auth",
		question: "Which auth system?",
		options: [{ id: OPTION, label: "GitHub Apps" }],
	});
	let state = applyEvent(initialState(), {
		id: "scoped-open",
		type: "thread.opened",
		threadId: "thread-a",
		observedThreadVersion: 0,
		origin: "planner",
		actor: { kind: "agent" },
		at: 1,
		question: "Which auth system?",
	});
	state = applyEvent(state, {
		id: "scoped-option",
		type: "option.added",
		threadId: "thread-a",
		observedThreadVersion: state.threads[0]!.version,
		origin: "planner",
		actor: { kind: "agent" },
		at: 1,
		contribution: { id: OPTION, text: "GitHub Apps", authoring: "scribe" },
	});
	state = applyEvent(state, {
		id: "scoped-link",
		type: "card.linked",
		threadId: "thread-a",
		observedThreadVersion: state.threads[0]!.version,
		origin: "classifier",
		actor: { kind: "classifier" },
		at: 1,
		questionnaireId: id,
	});
	let commands = cardEffects(
		context.plan,
		context.server,
		"test",
		{ record: async () => true } as unknown as Processor,
		undefined,
		{ chat: context.plan.chat, plan: context.plan, server: context.server, room: "test" },
	);
	let receipts = new Set<string>();
	let errors: unknown[] = [];
	let deps = {
		...commands,
		applied: (key: string) => receipts.has(key),
		markApplied: async (key: string) => {
			receipts.add(key);
		},
		report: (error: unknown) => errors.push(error),
	};
	let deliver = async (event: ConversationPlan.Event) => {
		state = applyEvent(state, event);
		await Service.exclusive(context.plan, async () => {
			context.plan.conversationPlan = state;
			if ("source" in event && event.source) {
				context.plan.chat.entries.push({
					id: event.source.messageId,
					author: event.source.author,
					text: event.source.quote,
					ts: event.at,
				});
			}
			await Service.persistExclusive(context.plan);
		});
		await runEffects(deps, effectsFor([event], state, undefined, context.plan.records));
	};
	let quote = "I'd pick GitHub Apps for the spike;";
	let proposal: Extract<ConversationPlan.Event, { type: "scoped-choice.proposed" }> = {
		id: "scoped-proposal",
		type: "scoped-choice.proposed",
		threadId: "thread-a",
		observedThreadVersion: state.threads[0]!.version,
		origin: "classifier",
		actor: { kind: "classifier" },
		at: 2,
		source: {
			messageId: "scoped-mei",
			author: { kind: "member", handle: "mei" },
			quote,
			start: 0,
			end: quote.length,
			role: "support",
		},
		cardId: id,
		optionId: OPTION,
		label: "GitHub Apps",
		scope: "spike",
	};
	await deliver(proposal);
	let agreementQuote = "yep, GitHub Apps for the spike.";
	let agreement: Extract<ConversationPlan.Event, { type: "scoped-choice.agreed" }> = {
		id: "scoped-agreement",
		type: "scoped-choice.agreed",
		threadId: "thread-a",
		observedThreadVersion: state.threads[0]!.version,
		origin: "classifier",
		actor: { kind: "classifier" },
		at: 3,
		source: {
			messageId: "scoped-rob",
			author: { kind: "member", handle: "rob" },
			quote: agreementQuote,
			start: 0,
			end: agreementQuote.length,
			role: "support",
		},
		proposalId: proposal.id,
		cardId: id,
		optionId: OPTION,
		label: "GitHub Apps",
		scope: "spike",
	};
	if (withAgreement) await deliver(agreement);
	return { context, proposal, agreement, deliver, state: () => state, errors };
}
