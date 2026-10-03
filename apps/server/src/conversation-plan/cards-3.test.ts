import { expect, test } from "bun:test";

import { cardEffects, mirrorCard, wakeCardMirror } from "./cards";
import { runEffects } from "./effects";
import { effectsFor } from "./effects";
import { initialState } from "./domain";
import { applyEvent } from "./events";
import * as Questions from "../questions/service";
import * as Store from "../questions/store";

import { openPlan } from "../testing/plan";
import type { ConversationPlan } from "@chopin/protocol";
import type { Plan } from "../plan/service";
import type { PendingCardAction } from "../questions/card-actions";
import type { Processor } from "./service";
import { base, CARD, cardSource, OPTION, plans, thread } from "./cards.test-fixtures";

// Whole archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2 callbacks.
test("a withdrawn proposer refreshes the stored advisory and durable Chat prompt to the surviving agreement", async () => {
	let context = await openPlan();
	plans.push(context.plan);
	let id = await Questions.insertConversationCard(context.plan, context.server, "test", {
		threadId: "thread-a",
		header: "Auth",
		question: "Which auth system?",
		options: [{ id: OPTION, label: "GitHub Apps" }],
	});
	let proposed: ConversationPlan.Event = {
		id: "proposed",
		type: "settle.suggested",
		threadId: "thread-a",
		observedThreadVersion: 4,
		origin: "classifier",
		actor: { kind: "classifier" },
		at: 5,
		source: cardSource("m5", "Bram", "resolution"),
		optionId: OPTION,
	};
	let agreed: ConversationPlan.Event = {
		...proposed,
		id: "agreed",
		type: "settle.agreed",
		source: cardSource("m6", "Ada", "support"),
	};
	let withdrawn: ConversationPlan.Event = {
		...proposed,
		id: "withdrawn",
		type: "stance.changed",
		scopedProposalId: null,
		source: cardSource("m7", "Bram", "objection"),
		position: "oppose",
	};
	context.plan.conversationPlan.threads = [{
		...thread(),
		questionnaireId: id,
		pendingSettle: { optionId: OPTION, proposer: "Bram", messageId: "m5" },
	}];
	context.plan.conversationPlan.events = [proposed];
	let commands = cardEffects(
		context.plan,
		context.server,
		"test",
		{ record: async () => true } as unknown as Processor,
		undefined,
		{ chat: context.plan.chat, plan: context.plan, server: context.server, room: "test" },
	);
	let receipts = new Set<string>();
	let deps = {
		...commands,
		applied: (key: string) => receipts.has(key),
		markApplied: async (key: string) => void receipts.add(key),
	};
	let records = new Map([[id, { history: [] }]]);
	let first = effectsFor([proposed], context.plan.conversationPlan, undefined, records);
	expect(await runEffects(deps, first)).toBe(2);
	expect(Store.get(context.plan.questions, id)?.suggested?.messageIds).toEqual(["m5"]);
	context.plan.conversationPlan.events = [proposed, agreed, withdrawn];
	let latest = effectsFor([agreed, withdrawn], context.plan.conversationPlan, undefined, records);
	expect(await runEffects(deps, latest)).toBe(2);
	expect(Store.get(context.plan.questions, id)?.suggested?.messageIds).toEqual(["m6"]);
	expect(
		context.plan.chat.entries.map(entry =>
			entry.decision?.kind === "prompt" ? entry.decision.sourceMessageIds : undefined
		),
	).toEqual([
		["m5"],
		["m6"],
	]);
	expect(context.plan.records.get(id)?.history).toEqual([]);
	let adaWithdrawn: ConversationPlan.Event = {
		...withdrawn,
		id: "ada-withdrawn",
		source: cardSource("m8", "Ada", "objection"),
	};
	context.plan.conversationPlan.events.push(adaWithdrawn);
	expect(
		await runEffects(
			deps,
			effectsFor([adaWithdrawn], context.plan.conversationPlan, undefined, records),
		),
	).toBe(2);
	expect(Store.get(context.plan.questions, id)?.suggested).toBeUndefined();
	expect(context.plan.chat.entries.at(-1)?.decision).toMatchObject({ sourceMessageIds: [] });
	expect(context.plan.records.get(id)?.history).toEqual([]);
	expect(await runEffects({ ...deps, applied: () => false }, first)).toBe(2);
	expect(context.plan.chat.entries).toHaveLength(3);
});

test("recovery mirrors held Save, Reopen, Save before card.linked and retries a failed first write", async () => {
	let actions: PendingCardAction[] = [
		{
			...base(),
			id: `card:${CARD}:decided:1`,
			kind: "decided",
			generation: 1,
			optionIds: [OPTION],
			text: "GitHub Apps",
		},
		{
			...base(),
			id: `card:${CARD}:reopened:1`,
			kind: "reopened",
			generation: 1,
			actor: "ben",
			at: 10,
		},
		{
			...base(),
			id: `card:${CARD}:decided:2`,
			kind: "decided",
			generation: 2,
			actor: "cy",
			at: 11,
			optionIds: [OPTION],
			text: "GitHub Apps",
		},
	];
	let plan = {
		pendingCardActions: structuredClone(actions),
		conversationPlan: { ...initialState(), threads: [thread()] },
	} as Plan;
	let fail = true;
	let processor = {
		record: async (
			make: (state: ConversationPlan.State) => ConversationPlan.Event | undefined,
			id: string,
		) => {
			if (fail) {
				fail = false;
				throw new Error("storage failed");
			}
			expect(plan.pendingCardActions[0]!.id).toBe(id);
			let event = make(plan.conversationPlan);
			if (event) plan.conversationPlan = applyEvent(plan.conversationPlan, event);
			plan.pendingCardActions = plan.pendingCardActions.slice(1);
			return !!event;
		},
	} as unknown as Processor;
	await expect(mirrorCard(plan, processor)).rejects.toThrow("storage failed");
	expect(plan.pendingCardActions).toEqual(actions);
	await mirrorCard(plan, processor);
	expect(plan.pendingCardActions).toEqual([]);
	expect(plan.conversationPlan.threads[0]!.questionnaireId).toBeUndefined();
	expect(plan.conversationPlan.threads[0]!.decisionHistory.map(item => item.actor)).toEqual([
		{ kind: "member", handle: "ana" },
		{ kind: "member", handle: "cy" },
	]);
	expect(plan.conversationPlan.events.map(item => item.id)).toEqual(actions.map(item => item.id));
});

test("normal room wake retries one failed mirror without spinning", async () => {
	let action: PendingCardAction = {
		...base(),
		id: `card:${CARD}:decided:1`,
		kind: "decided",
		generation: 1,
		optionIds: [OPTION],
		text: "GitHub Apps",
	};
	let plan = {
		pendingCardActions: [action],
		conversationPlan: { ...initialState(), threads: [thread()] },
	} as Plan;
	let attempts = 0;
	let wakes = 0;
	let processor = {
		wake() {
			wakes++;
		},
		record: async (make: (state: ConversationPlan.State) => ConversationPlan.Event, id: string) => {
			attempts++;
			if (attempts === 1) throw new Error("storage unavailable");
			expect(plan.pendingCardActions[0]?.id).toBe(id);
			plan.conversationPlan = applyEvent(plan.conversationPlan, make(plan.conversationPlan));
			plan.pendingCardActions = [];
			return true;
		},
	} as unknown as Processor;
	await expect(mirrorCard(plan, processor)).rejects.toThrow("storage unavailable");
	expect(plan.pendingCardActions).toEqual([action]);
	expect(attempts).toBe(1);
	await wakeCardMirror(plan, processor);
	expect(wakes).toBe(1);
	expect(attempts).toBe(2);
	expect(plan.pendingCardActions).toEqual([]);
	expect(plan.conversationPlan.threads[0]?.decisionHistory[0]?.text).toBe("GitHub Apps");
});
