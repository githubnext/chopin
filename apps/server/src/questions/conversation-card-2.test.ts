import { expect, test } from "bun:test";

import * as Questions from "./service";
import * as Store from "./store";

import * as room from "../plan/room";
import * as Service from "../plan/service";
import { openPlan } from "../testing/plan";

import { createConversationCardFixture } from "./conversation-card.test-fixtures";
import type { Plan } from "../plan/service";

let plans: Plan[];
let fixture = createConversationCardFixture(() => plans, value => {
	plans = value;
});
plans = fixture.plans;
let { OPTION, SECOND, input, quotedOption } = fixture;

// Whole archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2 callbacks.
test("relabel refuses stale, grouped, duplicate, and invalid-source requests without a mutation", async () => {
	let { context, id, state } = await quotedOption();
	let request = {
		operationId: "shorten-github",
		threadId: "thread-a",
		optionId: OPTION,
		label: "GitHub Apps",
		expectedThreadVersion: state.threads[0]!.version,
		expectedCardRevision: Store.get(context.plan.questions, id)!.revision,
	};
	let original = room.project(context.plan.document);
	let broadcasts = context.broadcasts.length;
	for (
		let input of [
			{ ...request, expectedThreadVersion: request.expectedThreadVersion - 1 },
			{ ...request, expectedCardRevision: request.expectedCardRevision + 1 },
			{ ...request, label: "Use OAuth" },
			{ ...request, label: "GitHub Apps or OAuth" },
			{ ...request, label: " " },
		]
	) {
		await expect(Questions.relabelConversationOption(context.plan, context.server, "test", input))
			.rejects.toThrow();
	}
	let message = context.plan.chat.entries.find(item => item.id === "quoted-option-message")!;
	message.text = "Changed after citation";
	await expect(Questions.relabelConversationOption(context.plan, context.server, "test", request))
		.rejects.toThrow("quote does not match");
	message.text = "We should use GitHub Apps for auth";
	expect(context.plan.conversationPlan).toEqual(state);
	expect(context.plan.records.get(id)!.definition.questions[0]!.options[0]!.label)
		.toBe("We should use GitHub Apps for auth");
	expect(Store.get(context.plan.questions, id)!.revision).toBe(request.expectedCardRevision);
	expect(room.project(context.plan.document)).toBe(original);
	expect(context.broadcasts).toHaveLength(broadcasts);
});

test("relabel storage failure leaves both states unchanged and retry succeeds", async () => {
	let { context, id, state } = await quotedOption();
	let request = {
		operationId: "shorten-github",
		threadId: "thread-a",
		optionId: OPTION,
		label: "GitHub Apps",
		expectedThreadVersion: state.threads[0]!.version,
		expectedCardRevision: Store.get(context.plan.questions, id)!.revision,
	};
	let source = room.project(context.plan.document);
	let broadcasts = context.broadcasts.length;
	let original = context.storage.collaboration.commit;
	(context.storage.collaboration as { commit: typeof original }).commit = async () => {
		throw new Error("storage unavailable");
	};
	try {
		await expect(Questions.relabelConversationOption(context.plan, context.server, "test", request))
			.rejects.toThrow("storage unavailable");
	} finally {
		(context.storage.collaboration as { commit: typeof original }).commit = original;
	}
	expect(context.plan.conversationPlan).toEqual(state);
	expect(context.plan.records.get(id)!.definition.questions[0]!.options[0]!.label)
		.toBe("We should use GitHub Apps for auth");
	expect(Store.get(context.plan.questions, id)!.revision).toBe(request.expectedCardRevision);
	expect(room.project(context.plan.document)).toBe(source);
	expect(context.broadcasts).toHaveLength(broadcasts);
	await Questions.relabelConversationOption(context.plan, context.server, "test", request);
	expect(context.plan.records.get(id)!.definition.questions[0]!.options[0]!.label)
		.toBe("GitHub Apps");
});

test("relabel refuses a claimed implementation and a closed card", async () => {
	let { context, id, state } = await quotedOption();
	let request = {
		operationId: "shorten-github",
		threadId: "thread-a",
		optionId: OPTION,
		label: "GitHub Apps",
		expectedThreadVersion: state.threads[0]!.version,
		expectedCardRevision: Store.get(context.plan.questions, id)!.revision,
	};
	context.plan.execution = { id: "run-1" } as never;
	await expect(Questions.relabelConversationOption(context.plan, context.server, "test", request))
		.rejects.toThrow("implementation is active");
	context.plan.execution = undefined;
	context.plan.records.get(id)!.status = "discarded";
	await expect(Questions.relabelConversationOption(context.plan, context.server, "test", request))
		.rejects.toThrow("no longer editable");
	expect(context.plan.conversationPlan).toEqual(state);
});

test("a failed insert leaves no live or durable half-card and succeeds on retry", async () => {
	let context = await openPlan();
	plans.push(context.plan);
	let original = context.storage.collaboration.commit;
	let before = context.broadcasts.length;
	(context.storage.collaboration as { commit: typeof original }).commit = async () => {
		throw new Error("storage unavailable");
	};
	try {
		await expect(Questions.insertConversationCard(context.plan, context.server, "test", input()))
			.rejects.toThrow("storage unavailable");
	} finally {
		(context.storage.collaboration as { commit: typeof original }).commit = original;
	}
	expect(context.plan.records.size).toBe(0);
	expect(context.plan.questions.open.size).toBe(0);
	expect(room.project(context.plan.document)).not.toContain("<Questionnaire");
	expect(context.broadcasts).toHaveLength(before);
	let id = await Questions.insertConversationCard(context.plan, context.server, "test", input());
	expect(context.plan.records.has(id)).toBe(true);
});

test("server option addition respects the held lock and rejects duplicate labels", async () => {
	let context = await openPlan();
	plans.push(context.plan);
	let id = await Questions.insertConversationCard(context.plan, context.server, "test", input());
	let events: Questions.CardEvent[] = [];
	let off = Questions.listen(context.plan, event => events.push(event));
	let outcome = await Service.exclusive(
		context.plan,
		() =>
			Questions.addServerOption(context.plan, context.server, "test", id, {
				optionId: OPTION,
				label: "GitHub Apps",
				origin: "planner",
				rationale: "Fits the existing repository permissions.",
			}, true),
	);
	off();
	expect(outcome).toEqual({ ok: true, optionId: OPTION });
	expect(context.plan.records.get(id)!.optionOrigins[OPTION]).toEqual({
		origin: "planner",
		rationale: "Fits the existing repository permissions.",
	});
	expect(events).toMatchObject([{ kind: "option-added", optionId: OPTION, origin: "planner" }]);
	expect(
		await Questions.addServerOption(context.plan, context.server, "test", id, {
			optionId: SECOND,
			label: "github apps",
			origin: "chat",
		}),
	).toEqual({ ok: false, reason: "duplicate" });
});

test("a failed option commit leaves the record, draft, and document unchanged", async () => {
	let context = await openPlan();
	plans.push(context.plan);
	let id = await Questions.insertConversationCard(context.plan, context.server, "test", input());
	let original = context.storage.collaboration.commit;
	let before = context.broadcasts.length;
	let source = room.project(context.plan.document);
	let revision = Store.get(context.plan.questions, id)!.revision;
	(context.storage.collaboration as { commit: typeof original }).commit = async () => {
		throw new Error("storage unavailable");
	};
	try {
		await expect(Questions.addServerOption(context.plan, context.server, "test", id, {
			optionId: OPTION,
			label: "GitHub Apps",
			origin: "chat",
		})).rejects.toThrow("storage unavailable");
	} finally {
		(context.storage.collaboration as { commit: typeof original }).commit = original;
	}
	expect(context.plan.records.get(id)!.definition.questions[0]!.options).toEqual([]);
	expect(Store.get(context.plan.questions, id)!.definition.questions[0]!.options).toEqual([]);
	expect(Store.get(context.plan.questions, id)!.revision).toBe(revision);
	expect(room.project(context.plan.document)).toBe(source);
	expect(context.broadcasts).toHaveLength(before);
	expect(
		await Questions.addServerOption(context.plan, context.server, "test", id, {
			optionId: OPTION,
			label: "GitHub Apps",
			origin: "chat",
		}),
	).toEqual({ ok: true, optionId: OPTION });
});
