import { expect, test } from "bun:test";

import { cardEffects } from "./cards";
import { runEffects } from "./effects";
import { effectsFor } from "./effects";

import * as Questions from "../questions/service";
import * as Store from "../questions/store";

import { openPlan } from "../testing/plan";
import type { ConversationPlan } from "@chopin/protocol";

import type { Processor } from "./service";
import { cardSource, OPTION, plans, thread } from "./cards.test-fixtures";

// Whole archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2 callbacks.
test("source withdrawal and recurring clear supersede durable Chat notices", async () => {
	let context = await openPlan();
	plans.push(context.plan);
	let id = await Questions.insertConversationCard(context.plan, context.server, "test", {
		threadId: "thread-a",
		header: "Auth",
		question: "Which auth system?",
		options: [{ id: OPTION, label: "GitHub Apps" }],
	});
	let proposal: ConversationPlan.Event = {
		id: "proposal",
		type: "settle.suggested",
		threadId: "thread-a",
		observedThreadVersion: 4,
		origin: "classifier",
		actor: { kind: "classifier" },
		at: 5,
		source: cardSource("m5", "Bram", "resolution"),
		optionId: OPTION,
	};
	let agreement: ConversationPlan.Event = {
		...proposal,
		id: "agreement",
		type: "settle.agreed",
		source: cardSource("m6", "Ada", "support"),
	};
	let adaWithdrawal: ConversationPlan.Event = {
		...proposal,
		id: "ada-withdrawal",
		type: "stance.changed",
		scopedProposalId: null,
		source: cardSource("m7", "Ada", "objection"),
		position: "oppose",
	};
	let bramWithdrawal: ConversationPlan.Event = {
		...adaWithdrawal,
		id: "bram-withdrawal",
		source: cardSource("m8", "Bram", "objection"),
	};
	let newProposal: ConversationPlan.Event = {
		...proposal,
		id: "new-proposal",
		source: cardSource("m9", "Bram", "resolution"),
	};
	let secondWithdrawal: ConversationPlan.Event = {
		...bramWithdrawal,
		id: "second-withdrawal",
		source: cardSource("m10", "Bram", "objection"),
	};
	context.plan.conversationPlan.threads = [{
		...thread(),
		questionnaireId: id,
		pendingSettle: { optionId: OPTION, proposer: "Bram", messageId: "m5" },
	}];
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
	for (
		let [event, expectedSources] of [
			[proposal, ["m5"]],
			[agreement, ["m5", "m6"]],
			[adaWithdrawal, ["m5"]],
			[bramWithdrawal, []],
			[newProposal, ["m9"]],
			[secondWithdrawal, []],
		] as const
	) {
		context.plan.conversationPlan.events.push(event);
		if (event === newProposal) {
			context.plan.conversationPlan.threads[0]!.pendingSettle = {
				optionId: OPTION,
				proposer: "Bram",
				messageId: "m9",
			};
		}
		expect(
			await runEffects(
				deps,
				effectsFor([event], context.plan.conversationPlan, undefined, records),
			),
		).toBe(2);
		expect(Store.get(context.plan.questions, id)?.suggested?.messageIds ?? [])
			.toEqual([...expectedSources]);
	}
	expect(Store.get(context.plan.questions, id)?.suggested).toBeUndefined();
	expect(
		context.plan.chat.entries.map(entry =>
			entry.decision?.kind === "prompt" ? entry.decision.sourceMessageIds : undefined
		),
	).toEqual([
		["m5"],
		["m5", "m6"],
		["m5"],
		[],
		["m9"],
		[],
	]);
	expect(
		await runEffects(
			{ ...deps, applied: () => false },
			effectsFor([secondWithdrawal], context.plan.conversationPlan, undefined, records),
		),
	).toBe(2);
	expect(context.plan.chat.entries).toHaveLength(6);
	expect(context.plan.records.get(id)?.history).toEqual([]);
});
