import { expect, test } from "bun:test";
import * as Question from "@chopin/question";

import * as Questions from "./questions/service";
import * as Store from "./questions/store";
import * as room from "./plan/room";
import * as Service from "./plan/service";

import { openPlan } from "./testing/plan";

import type { Plan } from "./plan/service";

import { createQuestionServiceFixture } from "./question-service.test-fixtures";
import {
	activateD02Deferral,
	d02DeferralQuote,
	d02Settlement,
} from "./question-service-deferral.test-fixtures";
let plans: Plan[];
let fixture = createQuestionServiceFixture(() => plans, value => {
	plans = value;
});
plans = fixture.plans;
let { restart, definition, asking, selectFirstOption, member } = fixture;

// Retained durability scenarios share the existing draft-selection helper.
test("submitting a chosen option projects its id and preserves it after restart", async () => {
	let context = await openPlan();
	let plan = context.plan;
	plans.push(plan);
	let asked = asking(plan, context.server, definition());
	await asked.created;
	let record = [...plan.records.values()][0]!;
	let question = record.definition.questions[0]!;
	let { ws, frames } = member();
	await selectFirstOption(plan, ws, record.id);
	let revision = Store.get(plan.questions, record.id)!.revision;
	await Questions.submit(plan, context.server, "test", ws, {
		kind: "question:submit",
		ts: 0,
		rid: "save",
		id: record.id,
		revision,
	});
	await asked.waiting;

	let projected = `<Answer value="Choose this" choices="${question.options[0]!.id}"`;
	expect(frames.find(frame => frame.rid === "save")).toMatchObject({ ok: true });
	expect(room.project(plan.document)).toContain(projected);
	let reopened = await restart(context);
	expect(room.project(reopened.document)).toContain(projected);
});

test("a current-revision manual Save is refused before the deferred draft is claimed", async () => {
	let context = await openPlan();
	let plan = context.plan;
	plans.push(plan);
	let asked = asking(plan, context.server, definition());
	await asked.created;
	let id = [...plan.records.keys()][0]!;
	let actor = member("Bram");
	let optionId = await selectFirstOption(plan, actor.ws, id);
	let seed = d02Settlement(plan, id);
	activateD02Deferral(plan, seed.deferral);
	await Service.persist(plan);
	let source = room.project(plan.document);
	let events = structuredClone(plan.conversationPlan.events);
	let transcript = structuredClone(plan.chat.entries);
	let storedBefore = await context.storage.collaboration.load(context.channel.id, context.now);
	let revision = Store.get(plan.questions, id)!.revision;
	let entered = Promise.withResolvers<void>();
	let release = Promise.withResolvers<void>();
	let blocker = Service.exclusive(plan, async () => {
		entered.resolve();
		await release.promise;
	});
	await entered.promise;
	let completed = false;
	let submitting = Questions.submit(plan, context.server, "test", actor.ws, {
		kind: "question:submit",
		ts: 0,
		rid: "deferred-manual-save",
		id,
		revision,
	}).then(() => completed = true);
	try {
		await Bun.sleep(20);
		expect(completed).toBe(true);
		expect(Store.get(plan.questions, id)?.claim).toBeUndefined();
		expect(actor.frames.find(frame => frame.rid === "deferred-manual-save")).toMatchObject({
			kind: "question:submit",
			ok: false,
			reason: "invalid",
			message: expect.stringMatching(/paused pending verification/i),
		});
	} finally {
		release.resolve();
		await Promise.all([blocker, submitting]);
	}
	expect(plan.records.get(id)?.status).toBe("open");
	expect(Store.get(plan.questions, id)?.claim).toBeUndefined();
	expect(
		Question.read(
			Store.get(plan.questions, id)!.model,
			plan.records.get(id)!.definition,
		)[plan.records.get(id)!.definition.questions[0]!.id]!.choice,
	).toBe(optionId);
	expect(room.project(plan.document)).toBe(source);
	expect(plan.conversationPlan.events).toEqual(events);
	expect(plan.chat.entries).toEqual(transcript);
	expect(await context.storage.collaboration.load(context.channel.id, context.now)).toEqual(
		storedBefore,
	);
});

test("a deferral committed ahead of a claimed submit restores the selected draft", async () => {
	let context = await openPlan();
	let plan = context.plan;
	plans.push(plan);
	let asked = asking(plan, context.server, definition());
	await asked.created;
	let id = [...plan.records.keys()][0]!;
	let actor = member("Bram");
	let optionId = await selectFirstOption(plan, actor.ws, id);
	let seed = d02Settlement(plan, id);
	await Service.persist(plan);
	let source = room.project(plan.document);
	let transcript = structuredClone(plan.chat.entries);
	let revision = Store.get(plan.questions, id)!.revision;
	let entered = Promise.withResolvers<void>();
	let release = Promise.withResolvers<void>();
	let blocker = Service.exclusive(plan, async () => {
		entered.resolve();
		await release.promise;
	});
	await entered.promise;
	let deferring = Service.exclusive(plan, async () => {
		activateD02Deferral(plan, seed.deferral);
		await Service.persistExclusive(plan);
	});
	let submitting = Questions.submit(plan, context.server, "test", actor.ws, {
		kind: "question:submit",
		ts: 0,
		rid: "racing-save",
		id,
		revision,
	});
	let eventCount = plan.conversationPlan.events.length;
	try {
		await Bun.sleep(20);
		expect(Store.get(plan.questions, id)?.claim).toBe("submit");
	} finally {
		release.resolve();
		await Promise.all([blocker, deferring, submitting]);
	}
	let reply = actor.frames.find(frame => frame.rid === "racing-save");
	expect(reply).toMatchObject({
		kind: "question:submit",
		ok: false,
		reason: "invalid",
		message: expect.stringMatching(/paused pending verification/i),
	});
	expect(plan.records.get(id)?.status).toBe("open");
	expect(Store.get(plan.questions, id)?.claim).toBeUndefined();
	expect(
		Question.read(
			Store.get(plan.questions, id)!.model,
			plan.records.get(id)!.definition,
		)[plan.records.get(id)!.definition.questions[0]!.id]!.choice,
	).toBe(optionId);
	expect(room.project(plan.document)).toBe(source);
	expect(plan.conversationPlan.events).toHaveLength(eventCount + 1);
	expect(plan.conversationPlan.events.at(-1)).toMatchObject({
		id: seed.deferral.id,
		proposalId: seed.proposal.id,
		source: expect.objectContaining({
			messageId: "m7",
			quote: d02DeferralQuote,
			role: "constraint",
		}),
	});
	expect(plan.chat.entries).toEqual(transcript);
	let stored = await context.storage.collaboration.load(context.channel.id, context.now);
	expect(stored?.sidecar).toMatchObject({
		conversationPlan: {
			events: expect.arrayContaining([
				expect.objectContaining({
					id: seed.deferral.id,
					proposalId: seed.proposal.id,
				}),
			]),
		},
	});
});
