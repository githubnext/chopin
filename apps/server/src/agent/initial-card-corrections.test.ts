import { expect, test } from "bun:test";
import { ulid } from "@chopin/dialect";
import * as Service from "../plan/service";
import { applyEvent } from "../conversation-plan/events";
import { effectsFor } from "../conversation-plan/effects";
import { createCardTargets } from "../conversation-plan/card-effect-targets";
import type { Processor } from "../conversation-plan/service";
import { fixture } from "./initial-card.test-fixtures";

async function option() {
	let h = await fixture();
	let id = ulid();
	let quote = "GitHub Apps";
	let source = {
		...h.source,
		messageId: "option-message",
		quote,
		end: quote.length,
		role: "option" as const,
	};
	h.plan.chat.entries.push({ id: source.messageId, author: source.author, text: quote, ts: 2 });
	h.plan.conversationPlan = applyEvent(h.plan.conversationPlan, {
		id: "option-event",
		type: "option.added",
		threadId: h.intent.threadId,
		observedThreadVersion: 1,
		origin: "classifier",
		actor: { kind: "classifier" },
		at: 2,
		source,
		contribution: { id, text: quote, authoring: "quoted" },
	});
	return { h, id, source };
}

test("an authorized option correction during initial generation retains its exact evidence", async () => {
	let { h, id, source } = await option();
	h.plan.conversationPlan = applyEvent(h.plan.conversationPlan, {
		id: "human:test:correction",
		type: "card.corrected",
		threadId: h.intent.threadId,
		observedThreadVersion: 2,
		origin: "human",
		actor: { kind: "member", handle: "test" },
		at: 3,
		change: {
			kind: "edit",
			field: "contribution",
			contributionId: id,
			text: "GitHub App authentication",
		},
	});
	await Service.persist(h.plan);
	let jobs = h.start();
	await jobs.enqueue(h.intent, h.effect.key);
	await jobs.idle();
	expect(jobs.jobs()[0]).toMatchObject({ status: "done" });
	let record = h.plan.records.get(h.intent.target)!;
	expect(record.definition.questions[0]?.options).toMatchObject([{
		id,
		label: "GitHub App authentication",
	}]);
	expect(record.optionOrigins[id]?.source).toEqual(source);
	let stored = (await h.storage.collaboration.load(h.plan.id, h.now))!;
	await expect(Service.readStored(stored)).resolves.toBeDefined();
});

test("moving an option before publication keeps it in its current thread and suppresses its old pending effect", async () => {
	let { h, id, source } = await option();
	let opening = {
		...h.plan.conversationPlan.events[0]!,
		id: "second-opening",
		threadId: "second-thread",
		observedThreadVersion: 0,
	};
	h.plan.conversationPlan = applyEvent(h.plan.conversationPlan, opening);
	let effect = effectsFor([opening], h.plan.conversationPlan)[0]!;
	h.plan.conversationPlanPendingEffects.push(effect);
	h.plan.conversationPlan = applyEvent(h.plan.conversationPlan, {
		id: "human:test:move",
		type: "card.corrected",
		threadId: h.intent.threadId,
		observedThreadVersion: 2,
		origin: "human",
		actor: { kind: "member", handle: "test" },
		at: 3,
		change: { kind: "move", contributionId: id, targetThreadId: "second-thread", targetVersion: 1 },
	});
	await Service.persist(h.plan);
	let jobs = h.start();
	await jobs.enqueue(h.intent, h.effect.key);
	await jobs.idle();
	let otherId = ulid();
	await jobs.enqueue({
		kind: "refine",
		target: otherId,
		threadId: "second-thread",
		trigger: opening.id,
	}, effect.key);
	await jobs.idle();
	expect(jobs.jobs().map(job => job.status)).toEqual(["done", "done"]);
	let commands = createCardTargets(h.plan, h.server, h.plan.id, {} as Processor);
	await commands.addOption(h.intent.target, {
		optionId: id,
		label: source.quote,
		source,
		trigger: "option-event",
	});
	expect(h.plan.records.get(h.intent.target)?.definition.questions[0]?.options).toEqual([]);
	let moved = h.plan.records.get(otherId)!;
	expect(moved.definition.questions[0]?.options).toMatchObject([{ id, label: source.quote }]);
	expect(moved.optionOrigins[id]?.source).toEqual(source);
	let stored = (await h.storage.collaboration.load(h.plan.id, h.now))!;
	await expect(Service.readStored(stored)).resolves.toBeDefined();
});

test("restoration rejects forged option membership outside its accepted conversation history", async () => {
	let { h, id } = await option();
	for (let threadId of ["second-thread", "unrelated-third-thread"]) {
		h.plan.conversationPlan = applyEvent(h.plan.conversationPlan, {
			...h.plan.conversationPlan.events[0]!,
			id: `${threadId}-opening`,
			threadId,
			observedThreadVersion: 0,
		});
	}
	await Service.persist(h.plan);
	let jobs = h.start();
	await jobs.enqueue(h.intent, h.effect.key);
	await jobs.idle();
	let loaded = (await h.storage.collaboration.load(h.plan.id, h.now))!;
	let sidecar = structuredClone(loaded.sidecar ?? loaded.snapshot!.sidecar) as unknown as {
		questions: Array<{ threadId: string }>;
		conversationPlan: typeof h.plan.conversationPlan;
	};
	sidecar.questions[0]!.threadId = "unrelated-third-thread";
	await expect(Service.readStored({ ...loaded, sidecar: sidecar as never })).rejects.toThrow(
		"option source outside",
	);
	sidecar.questions[0]!.threadId = h.intent.threadId;
	let moved = sidecar.conversationPlan.threads[0]!.contributions.find(item => item.id === id)!;
	sidecar.conversationPlan.threads[1]!.contributions.push(moved);
	sidecar.conversationPlan.threads[0]!.contributions = sidecar.conversationPlan.threads[0]!
		.contributions.filter(item => item.id !== id);
	await expect(Service.readStored({ ...loaded, sidecar: sidecar as never })).rejects.toThrow();
});

test("a move that wins the document lock fences a queued old option delivery", async () => {
	let h = await fixture();
	let jobs = h.start();
	await jobs.enqueue(h.intent, h.effect.key);
	await jobs.idle();
	let id = ulid();
	let quote = "GitHub Apps";
	let source = {
		...h.source,
		messageId: "option-message",
		quote,
		end: quote.length,
		role: "option" as const,
	};
	h.plan.chat.entries.push({ id: source.messageId, author: source.author, text: quote, ts: 2 });
	h.plan.conversationPlan = applyEvent(h.plan.conversationPlan, {
		id: "late-option",
		type: "option.added",
		threadId: h.intent.threadId,
		observedThreadVersion: h.plan.conversationPlan.threads[0]!.version,
		origin: "classifier",
		actor: { kind: "classifier" },
		at: 2,
		source,
		contribution: { id, text: quote, authoring: "quoted" },
	});
	h.plan.conversationPlan = applyEvent(h.plan.conversationPlan, {
		...h.plan.conversationPlan.events[0]!,
		id: "second-opening",
		threadId: "second-thread",
		observedThreadVersion: 0,
	});
	let entered = Promise.withResolvers<void>();
	let release = Promise.withResolvers<void>();
	let move = Service.exclusive(h.plan, async () => {
		entered.resolve();
		await release.promise;
		h.plan.conversationPlan = applyEvent(h.plan.conversationPlan, {
			id: "human:test:late-move",
			type: "card.corrected",
			threadId: h.intent.threadId,
			observedThreadVersion: h.plan.conversationPlan.threads[0]!.version,
			origin: "human",
			actor: { kind: "member", handle: "test" },
			at: 3,
			change: {
				kind: "move",
				contributionId: id,
				targetThreadId: "second-thread",
				targetVersion: 1,
			},
		});
		await Service.persistExclusive(h.plan);
	});
	await entered.promise;
	let commands = createCardTargets(h.plan, h.server, h.plan.id, {} as Processor);
	let delivery = commands.addOption(h.intent.target, {
		optionId: id,
		label: quote,
		source,
		trigger: "late-option",
	});
	release.resolve();
	await Promise.all([move, delivery]);
	expect(h.plan.records.get(h.intent.target)?.definition.questions[0]?.options).toEqual([]);
	expect(h.plan.conversationPlan.threads[1]?.contributions[0]?.id).toBe(id);
});
