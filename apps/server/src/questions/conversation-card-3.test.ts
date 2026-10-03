import { expect, test } from "bun:test";
import * as Question from "@chopin/question";

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
let { OPTION, input } = fixture;

// Whole archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2 callbacks.
test("server retitle persists the record, draft, and one card prompt under the held lock", async () => {
	let context = await openPlan();
	plans.push(context.plan);
	let id = await Questions.insertConversationCard(
		context.plan,
		context.server,
		"test",
		input([{ id: OPTION, label: "GitHub Apps" }]),
	);
	await Questions.suggest(context.plan, context.server, "test", id, {
		optionId: OPTION,
		messageIds: ["m1"],
	});
	let before = context.broadcasts.length;
	let result = await Service.exclusive(
		context.plan,
		() =>
			Questions.retitle(context.plan, context.server, "test", id, "Which auth system first?", true),
	);
	expect(result).toMatchObject({ ok: true, revision: 2 });
	expect(context.plan.records.get(id)?.definition.questions[0]?.question).toBe(
		"Which auth system first?",
	);
	expect(Store.get(context.plan.questions, id)?.definition.questions[0]?.question).toBe(
		"Which auth system first?",
	);
	expect(Store.get(context.plan.questions, id)?.suggested?.revision).toBe(2);
	expect(room.project(context.plan.document)).toContain('prompt="Which auth system first?"');
	expect(context.broadcasts.slice(before).map(frame => frame.kind)).toEqual([
		"plan:update",
		"question:changed",
		"question:meta",
	]);
	let repeatedAt = context.broadcasts.length;
	expect(
		await Questions.retitle(
			context.plan,
			context.server,
			"test",
			id,
			" Which auth system first? ",
		),
	).toEqual({ ok: true, revision: 2 });
	expect(context.broadcasts).toHaveLength(repeatedAt);
	await Service.close(context.plan);
	plans = [];
	let restored = await Service.open(context.channel.id, context.backend, context.server);
	plans.push(restored);
	expect(restored.records.get(id)?.definition.questions[0]?.question).toBe(
		"Which auth system first?",
	);
	expect(Store.get(restored.questions, id)?.suggested?.revision).toBe(2);
	expect(room.project(restored.document)).toContain('prompt="Which auth system first?"');
});

test("a failed retitle commit does not leak a changed record, draft, document, or broadcast", async () => {
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
		await expect(Questions.retitle(
			context.plan,
			context.server,
			"test",
			id,
			"Which auth system first?",
		)).rejects.toThrow("storage unavailable");
	} finally {
		(context.storage.collaboration as { commit: typeof original }).commit = original;
	}
	expect(context.plan.records.get(id)?.definition.questions[0]?.question).toBe(
		"What auth system should we use?",
	);
	expect(Store.get(context.plan.questions, id)?.definition.questions[0]?.question).toBe(
		"What auth system should we use?",
	);
	expect(Store.get(context.plan.questions, id)?.revision).toBe(revision);
	expect(room.project(context.plan.document)).toBe(source);
	expect(context.broadcasts).toHaveLength(before);
	expect(
		await Questions.retitle(
			context.plan,
			context.server,
			"test",
			id,
			"Which auth system first?",
		),
	).toMatchObject({ ok: true });
});

test("a failed suggestion commit neither pre-selects nor announces until retry", async () => {
	let context = await openPlan();
	plans.push(context.plan);
	let id = await Questions.insertConversationCard(
		context.plan,
		context.server,
		"test",
		input([
			{ id: OPTION, label: "GitHub Apps" },
		]),
	);
	let original = context.storage.collaboration.commit;
	let before = context.broadcasts.length;
	(context.storage.collaboration as { commit: typeof original }).commit = async () => {
		throw new Error("storage unavailable");
	};
	try {
		await expect(Questions.suggest(context.plan, context.server, "test", id, {
			optionId: OPTION,
			messageIds: ["m1"],
		})).rejects.toThrow("storage unavailable");
	} finally {
		(context.storage.collaboration as { commit: typeof original }).commit = original;
	}
	let entry = Store.get(context.plan.questions, id)!;
	expect(entry.revision).toBe(0);
	expect(entry.suggested).toBeUndefined();
	expect(Question.read(entry.model, entry.definition)[entry.definition.questions[0]!.id]!.choice)
		.toBeNull();
	expect(context.broadcasts).toHaveLength(before);
	expect(
		await Questions.suggest(context.plan, context.server, "test", id, {
			optionId: OPTION,
			messageIds: ["m1"],
		}),
	).toBe(true);
	expect(context.broadcasts.slice(before).map(frame => frame.kind)).toEqual(["question:meta"]);
	expect(context.broadcasts.at(-1)).toMatchObject({
		kind: "question:meta",
		meta: { suggested: { optionId: OPTION, messageIds: ["m1"], revision: 1 } },
	});
	let after = context.broadcasts.length;
	expect(
		await Questions.suggest(context.plan, context.server, "test", id, {
			optionId: OPTION,
			messageIds: ["m1"],
		}),
	).toBe(true);
	expect(Store.get(context.plan.questions, id)!.revision).toBe(1);
	expect(context.broadcasts).toHaveLength(after);
});

test("withdrawal clears an advisory only after commit and leaves the human draft untouched", async () => {
	let context = await openPlan();
	plans.push(context.plan);
	let id = await Questions.insertConversationCard(
		context.plan,
		context.server,
		"test",
		input([{ id: OPTION, label: "VPS" }]),
	);
	expect(
		await Questions.suggest(context.plan, context.server, "test", id, {
			optionId: OPTION,
			messageIds: ["m5"],
		}),
	).toBe(true);
	let before = context.broadcasts.length;
	let original = context.storage.collaboration.commit;
	context.storage.collaboration.commit = async () => {
		throw new Error("storage unavailable");
	};
	try {
		await expect(Questions.suggest(context.plan, context.server, "test", id))
			.rejects.toThrow("storage unavailable");
	} finally {
		context.storage.collaboration.commit = original;
	}
	expect(Store.get(context.plan.questions, id)?.suggested?.messageIds).toEqual(["m5"]);
	expect(context.broadcasts).toHaveLength(before);
	expect(await Questions.suggest(context.plan, context.server, "test", id)).toBe(true);
	expect(await Questions.suggest(context.plan, context.server, "test", id)).toBe(true);
	let live = Store.get(context.plan.questions, id)!;
	expect(live.suggested).toBeUndefined();
	expect(live.revision).toBe(2);
	expect(Question.read(live.model, live.definition)[live.definition.questions[0]!.id]!.choice)
		.toBeNull();
	expect(context.plan.records.get(id)?.history).toEqual([]);
	expect(context.broadcasts.slice(before).map(frame => frame.kind)).toEqual(["question:meta"]);
	await Service.close(context.plan);
	plans = [];
	let restored = await Service.open(context.channel.id, context.backend, context.server);
	plans.push(restored);
	expect(Store.get(restored.questions, id)?.suggested).toBeUndefined();
	expect(restored.records.get(id)?.history).toEqual([]);
});
