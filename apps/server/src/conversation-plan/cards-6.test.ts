import { expect, test } from "bun:test";

import { cardEffects } from "./cards";
import { runEffects } from "./effects";
import { effectsFor } from "./effects";
import { initialState } from "./domain";
import { applyEvent } from "./events";
import * as Questions from "../questions/service";

import { openPlan } from "../testing/plan";
import type { ConversationPlan } from "@chopin/protocol";

import type { Processor } from "./service";
import { OPTION, plans } from "./cards.test-fixtures";

// Whole archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2 callbacks.
test("a scoped choice notice keeps every agreement across retries and delayed effects", async () => {
	let context = await openPlan();
	plans.push(context.plan);
	let id = await Questions.insertConversationCard(context.plan, context.server, "test", {
		threadId: "thread-a",
		header: "Auth",
		question: "Which auth system?",
		options: [{ id: OPTION, label: "GitHub Apps" }],
	});
	let opened: ConversationPlan.Event = {
		id: "scoped-open",
		type: "thread.opened",
		threadId: "thread-a",
		observedThreadVersion: 0,
		origin: "planner",
		actor: { kind: "agent" },
		at: 1,
		question: "Which auth system?",
	};
	let state = applyEvent(initialState(), opened);
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
	let quote = "I'd pick GitHub Apps for the spike;";
	let proposal: ConversationPlan.Event = {
		id: "scoped-proposal",
		type: "scoped-choice.proposed",
		threadId: "thread-a",
		observedThreadVersion: state.threads[0]!.version,
		origin: "classifier",
		actor: { kind: "classifier" },
		at: 2,
		source: {
			messageId: "scoped-m6",
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
	state = applyEvent(state, proposal);
	context.plan.conversationPlan = state;
	context.plan.chat.entries.push({
		id: "scoped-m6",
		author: { kind: "member", handle: "mei" },
		text: quote,
		ts: 2,
	});
	let commands = cardEffects(
		context.plan,
		context.server,
		"test",
		{ record: async () => true } as unknown as Processor,
		undefined,
		{ chat: context.plan.chat, plan: context.plan, server: context.server, room: "test" },
	);
	let effects = effectsFor([proposal], state, undefined, context.plan.records);
	let receipts = new Set<string>();
	let failReceipt = true;
	let errors: unknown[] = [];
	let deps = {
		...commands,
		applied: (key: string) => receipts.has(key),
		markApplied: async (key: string) => {
			if (failReceipt) {
				failReceipt = false;
				throw new Error("receipt unavailable");
			}
			receipts.add(key);
		},
		report: (error: unknown) => errors.push(error),
	};
	expect(await runEffects(deps, effects)).toBe(0);
	expect(context.plan.chat.entries.filter(entry => entry.decision?.kind === "scoped-choice"))
		.toHaveLength(1);
	expect(await runEffects(deps, effects)).toBe(1);
	expect(context.plan.chat.entries.filter(entry => entry.decision?.kind === "scoped-choice"))
		.toHaveLength(1);
	expect(context.plan.chat.entries.at(-1)?.decision).toMatchObject({
		kind: "scoped-choice",
		proposalId: proposal.id,
		triggerEventId: proposal.id,
		generation: 0,
		sources: [proposal.source],
	});
	expect(receipts).toEqual(new Set([effects[0]!.key]));
	expect(errors.map(String)).toEqual(["Error: receipt unavailable"]);

	let agreementQuote = "yep, GitHub Apps for the spike.";
	let firstAgreement: ConversationPlan.Event = {
		id: "scoped-agreement-rob",
		type: "scoped-choice.agreed",
		threadId: "thread-a",
		observedThreadVersion: state.threads[0]!.version,
		origin: "classifier",
		actor: { kind: "classifier" },
		at: 3,
		source: {
			messageId: "scoped-m7",
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
	state = applyEvent(state, firstAgreement);
	let secondAgreement: ConversationPlan.Event = {
		...firstAgreement,
		id: "scoped-agreement-ana",
		observedThreadVersion: state.threads[0]!.version,
		at: 4,
		source: {
			messageId: "scoped-m8",
			author: { kind: "member", handle: "ana" },
			quote: agreementQuote,
			start: 0,
			end: agreementQuote.length,
			role: "support",
		},
	};
	state = applyEvent(state, secondAgreement);
	context.plan.conversationPlan = state;
	for (let agreement of [firstAgreement, secondAgreement]) {
		if (agreement.type !== "scoped-choice.agreed") throw new Error("agreement missing");
		context.plan.chat.entries.push({
			id: agreement.source.messageId,
			author: agreement.source.author,
			text: agreement.source.quote,
			ts: agreement.at,
		});
	}
	let newer = effectsFor([secondAgreement], state, undefined, context.plan.records);
	let older = effectsFor([firstAgreement], state, undefined, context.plan.records);
	expect(await runEffects(deps, newer)).toBe(1);
	expect(await runEffects(deps, older)).toBe(1);
	let notices = context.plan.chat.entries.filter(entry => entry.decision?.kind === "scoped-choice");
	expect(notices).toHaveLength(1);
	let decision = notices[0]?.decision;
	if (decision?.kind !== "scoped-choice") throw new Error("scoped notice missing");
	expect(decision.sources).toEqual([
		proposal.source,
		firstAgreement.source,
		secondAgreement.source,
	]);
	expect(state.events.filter(event => event.type === "scoped-choice.agreed")).toHaveLength(2);
	expect(state.threads[0]?.status).toBe("exploring");
});
