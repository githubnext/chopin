import { expect, test } from "bun:test";

import { cardEffects } from "./cards";
import { runEffects } from "./effects";
import { effectsFor } from "./effects";
import { initialState } from "./domain";
import { applyEvent } from "./events";
import * as Questions from "../questions/service";

import * as Service from "../plan/service";
import { openPlan } from "../testing/plan";
import type { ConversationPlan } from "@chopin/protocol";

import type { Processor } from "./service";
import { OPTION, plans, scopedNoticeFixture } from "./cards.test-fixtures";

// Whole archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2 callbacks.
test("scoped notices for distinct card options keep separate identities", async () => {
	let context = await openPlan();
	plans.push(context.plan);
	let otherOption = "01K0N4W3B7P27CBAEC7A8C8WEC";
	let id = await Questions.insertConversationCard(context.plan, context.server, "test", {
		threadId: "thread-a",
		header: "Auth",
		question: "Which auth system?",
		options: [
			{ id: OPTION, label: "GitHub Apps" },
			{ id: otherOption, label: "Auth0" },
		],
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
	for (
		let [index, option] of [
			{ id: OPTION, label: "GitHub Apps" },
			{ id: otherOption, label: "Auth0" },
		].entries()
	) {
		let quote = `I'd pick ${option.label} for the spike;`;
		let proposal: ConversationPlan.Event = {
			id: `scoped-proposal-${index}`,
			type: "scoped-choice.proposed",
			threadId: "thread-a",
			observedThreadVersion: state.threads[0]!.version,
			origin: "classifier",
			actor: { kind: "classifier" },
			at: index + 2,
			source: {
				messageId: `scoped-message-${index}`,
				author: { kind: "member", handle: index === 0 ? "mei" : "ana" },
				quote,
				start: 0,
				end: quote.length,
				role: "support",
			},
			cardId: id,
			optionId: option.id,
			label: option.label,
			scope: "spike",
		};
		state = applyEvent(state, proposal);
		context.plan.conversationPlan = state;
		context.plan.chat.entries.push({
			id: proposal.source.messageId,
			author: proposal.source.author,
			text: quote,
			ts: proposal.at,
		});
		expect(await runEffects(deps, effectsFor([proposal], state, undefined, context.plan.records)))
			.toBe(1);
	}
	let notices = context.plan.chat.entries.filter(entry => entry.decision?.kind === "scoped-choice");
	expect(notices).toHaveLength(2);
	expect(
		notices.map(entry =>
			entry.decision?.kind === "scoped-choice" ? entry.decision.optionId : undefined
		),
	).toEqual([OPTION, otherOption]);
	expect(new Set(notices.map(entry => entry.id)).size).toBe(2);
	expect(state.threads[0]?.status).toBe("exploring");
	expect(errors).toEqual([]);
	let unrelated = notices[1]!;
	let unchanged = structuredClone(unrelated.decision);
	let quote = "I don't support that choice anymore.";
	let opposition: ConversationPlan.Event = {
		id: "first-option-proposer-opposes",
		type: "stance.changed",
		scopedProposalId: null,
		threadId: "thread-a",
		observedThreadVersion: state.threads[0]!.version,
		origin: "classifier",
		actor: { kind: "classifier" },
		at: 4,
		source: {
			messageId: "first-option-opposition",
			author: { kind: "member", handle: "mei" },
			quote,
			start: 0,
			end: quote.length,
			role: "objection",
		},
		position: "oppose",
	};
	state = applyEvent(state, opposition);
	await Service.exclusive(context.plan, async () => {
		context.plan.conversationPlan = state;
		context.plan.chat.entries.push({
			id: opposition.source.messageId,
			author: opposition.source.author,
			text: quote,
			ts: opposition.at,
		});
		await Service.persistExclusive(context.plan);
	});
	await runEffects(deps, effectsFor([opposition], state, undefined, context.plan.records));
	expect(context.plan.chat.entries.find(entry => entry.id === unrelated.id)?.decision)
		.toEqual(unchanged);
});

test("a later non-support stance removes only its speaker from the scoped notice", async () => {
	let fixture = await scopedNoticeFixture(true);
	let before = fixture.context.plan.chat.entries.find(entry =>
		entry.decision?.kind === "scoped-choice"
	);
	if (!before) throw new Error("scoped notice missing");
	expect(before?.decision).toMatchObject({
		sources: [fixture.proposal.source, fixture.agreement.source],
	});
	let quote = "I oppose GitHub Apps now.";
	await fixture.deliver({
		id: "rob-opposes",
		type: "stance.changed",
		scopedProposalId: fixture.proposal.id,
		threadId: "thread-a",
		observedThreadVersion: fixture.state().threads[0]!.version,
		origin: "classifier",
		actor: { kind: "classifier" },
		at: 4,
		source: {
			messageId: "scoped-rob-opposes",
			author: { kind: "member", handle: "rob" },
			quote,
			start: 0,
			end: quote.length,
			role: "objection",
		},
		optionId: OPTION,
		position: "oppose",
	});
	let notices = fixture.context.plan.chat.entries.filter(entry =>
		entry.decision?.kind === "scoped-choice"
	);
	expect(notices).toHaveLength(1);
	expect(notices[0]?.id).toBe(before?.id);
	expect(notices[0]?.decision).toMatchObject({ sources: [fixture.proposal.source] });
	expect(fixture.errors).toEqual([]);
});

test("a proposer's later opposition leaves no actionable scoped Save prompt", async () => {
	let fixture = await scopedNoticeFixture(false);
	let quote = "I oppose GitHub Apps now.";
	await fixture.deliver({
		id: "mei-opposes",
		type: "stance.changed",
		scopedProposalId: fixture.proposal.id,
		threadId: "thread-a",
		observedThreadVersion: fixture.state().threads[0]!.version,
		origin: "classifier",
		actor: { kind: "classifier" },
		at: 3,
		source: {
			messageId: "scoped-mei-opposes",
			author: { kind: "member", handle: "mei" },
			quote,
			start: 0,
			end: quote.length,
			role: "objection",
		},
		optionId: OPTION,
		position: "oppose",
	});
	let notices = fixture.context.plan.chat.entries.filter(entry =>
		entry.decision?.kind === "scoped-choice"
	);
	expect(notices.length === 0 || !fixture.state().threads[0]?.pendingScopedChoice).toBe(true);
	expect(fixture.errors).toEqual([]);
});
