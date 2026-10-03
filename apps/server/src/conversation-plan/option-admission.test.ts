import { expect, test } from "bun:test";
import * as Plan from "../plan/service";
import * as Room from "../plan/room";
import * as Questions from "../questions/service";
import * as Store from "../questions/store";
import { openPlan } from "../testing/plan";
import { applyInference, completeAnalysis, enqueue, initialState } from "./domain";
import { cardEffects, mirrorCard } from "./cards";
import { createProcessor } from "./service";
import { entry, opened } from "./service.test-fixtures";
import type { ConversationPlan } from "@chopin/protocol";
import type { Socket } from "../wire";
import type { Dependencies } from "./processor-types";
import type { JsonValue } from "../storage/model";

async function setup(optionCount: number, reasons = 0, interpret?: Dependencies["interpret"]) {
	let context = await openPlan();
	let { plan, server } = context;
	let question = entry("question", "Where should we host?");
	let excerpt = {
		...entry("excerpt", "Use the new provider."),
		author: { kind: "member" as const, handle: "alice" },
	};
	plan.chat.entries = [question, excerpt];
	let state = applyInference(initialState(), opened(question), question);
	let options = Array.from({ length: optionCount }, (_, index) => ({
		id: `01K0N4W3B7P27CBAEC7A8C8WE${index}`,
		label: `Provider ${index}`,
	}));
	for (
		let [index, text] of [
			...options.map(option => option.label),
			...Array.from({ length: reasons }, (_, i) => `Reason ${i}`),
		].entries()
	) {
		let message = entry(`evidence-${index}`, text);
		plan.chat.entries.push(message);
		let kind: "option" | "reason" = index < options.length ? "option" : "reason";
		state = applyInference(state, {
			id: `event-${index}`,
			type: `${kind}.added`,
			threadId: "thread-a",
			observedThreadVersion: state.threads[0]!.version,
			origin: "classifier",
			actor: { kind: "classifier" },
			at: 1000,
			source: {
				messageId: message.id,
				author: message.author as ConversationPlan.SourceAuthor,
				quote: text,
				start: 0,
				end: text.length,
				role: kind,
			},
			contribution: {
				id: options[index]?.id ?? `reason-${index}`,
				text,
				authoring: "quoted",
				targetId: "thread-a",
			},
		}, message);
	}
	plan.conversationPlan = completeAnalysis(enqueue(state, excerpt.id), excerpt.id, [], excerpt, {
		questionSetVersion: "conversation-plan-5",
		modelVersion: "fixture",
		status: "unlinked",
		passes: [],
		outcomes: [{
			start: 0,
			end: excerpt.text.length,
			status: "review",
			gate: "unclassified excerpt",
			eventIds: [],
		}],
	});
	await Plan.persist(plan);
	let cardId = await Questions.insertConversationCard(plan, server, plan.id, {
		threadId: "thread-a",
		header: "Hosting",
		question: question.text,
		options,
	});
	let errors: unknown[] = [];
	let processor = createProcessor({
		plan,
		interpret,
		exclusive: action => Plan.exclusive(plan, action),
		persist: () => Plan.persistExclusive(plan),
		active: () => true,
		publish() {},
		onError: error => errors.push(error),
	});
	let effects = cardEffects(plan, server, plan.id, processor, undefined, {
		chat: plan.chat,
		plan,
		server,
		room: plan.id,
	});
	await effects.link("thread-a", cardId);
	await processor.idle();
	let frames: Array<Record<string, unknown>> = [];
	let ws = {
		data: { handle: "carol", client: "carol", room: plan.id },
		send(raw: string) {
			frames.push(JSON.parse(raw));
		},
		publish() {},
	} as unknown as Socket;
	return {
		...context,
		cardId,
		processor,
		effects,
		errors,
		frames,
		ws,
		correct(kind: "option" | "reason" = "option") {
			return processor.correct({
				actionId: "add-excerpt",
				threadId: "thread-a",
				expectedVersion: plan.conversationPlan.threads[0]!.version,
				change: {
					kind: "add-excerpt",
					messageId: excerpt.id,
					start: 0,
					end: excerpt.text.length,
					contributionKind: kind,
				},
			}, { kind: "member", handle: "bob" });
		},
		append(label = "Another provider") {
			return Questions.addOption(plan, server, plan.id, ws, {
				kind: "question:option",
				rid: "append",
				ts: 0,
				id: cardId,
				question: Store.get(plan.questions, cardId)!.definition.questions[0]!.id,
				key: "new-option",
				label,
			});
		},
		async save() {
			let live = Store.get(plan.questions, cardId)!;
			let model = live.model.fork();
			model.api.val([live.definition.questions[0]!.id, "choice"]).set(options[0]!.id);
			await Questions.edit(plan, ws, {
				kind: "question:edit",
				rid: "select",
				ts: 0,
				id: cardId,
				patch: [...model.api.flush()!.toBinary()],
			});
			await Questions.submit(plan, server, plan.id, ws, {
				kind: "question:submit",
				rid: "save",
				ts: 0,
				id: cardId,
				revision: Store.get(plan.questions, cardId)!.revision,
			});
		},
		snapshot() {
			return structuredClone({
				record: plan.records.get(cardId),
				draft: Store.snapshot(plan.questions, cardId),
				conversation: plan.conversationPlan,
				source: Room.project(plan.document),
				pending: plan.pendingCardActions,
				pendingEffects: plan.conversationPlanPendingEffects,
				receipts: plan.conversationPlanEffects,
				broadcasts: context.broadcasts,
				storageRevision: plan.persistence.revision,
			});
		},
		async close() {
			processor.stop();
			await processor.idle();
			await Plan.close(plan);
		},
	};
}

test("a full card refuses human option correction before claiming it was added", async () => {
	let h = await setup(10);
	try {
		let before = h.snapshot();
		await expect(h.correct()).rejects.toThrow(/full|limit/i);
		expect(h.snapshot()).toEqual(before);
		expect(h.plan.conversationPlanPendingEffects.some(effect => effect.kind === "add-option")).toBe(
			false,
		);
	} finally {
		await h.close();
	}
});

test("a full discussion refuses an option before acknowledgement and still permits Save", async () => {
	let h = await setup(1, 63);
	try {
		let before = h.snapshot();
		await h.append();
		expect(h.frames.at(-1)).toMatchObject({ ok: false, reason: "full" });
		expect(h.snapshot()).toEqual(before);
		await h.save();
		await mirrorCard(h.plan, h.processor);
		expect(h.plan.records.get(h.cardId)?.status).toBe("answered");
		expect(h.plan.conversationPlan.threads[0]?.status).toBe("decided");
		expect(h.plan.pendingCardActions).toEqual([]);
	} finally {
		await h.close();
	}
});

test("a pending option mirror reserves the last discussion slot against corrections", async () => {
	let h = await setup(1, 62);
	try {
		await h.append();
		expect(h.frames.at(-1)?.ok).toBe(true);
		let before = h.snapshot();
		await expect(h.correct("reason")).rejects.toThrow(/contribution limit/i);
		expect(h.snapshot()).toEqual(before);
		await mirrorCard(h.plan, h.processor);
		expect(h.plan.conversationPlan.threads[0]?.contributions).toHaveLength(64);
		expect(h.plan.pendingCardActions).toEqual([]);
	} finally {
		await h.close();
	}
});

test("inference cannot consume a pending option mirror's reserved slot", async () => {
	let h = await setup(1, 62, async ({ state, message }) => ({
		events: [{
			id: "reason:inferred",
			type: "reason.added",
			threadId: "thread-a",
			observedThreadVersion: state.threads[0]!.version,
			origin: "classifier",
			actor: { kind: "classifier" },
			at: 1000,
			source: {
				messageId: message.id,
				author: message.author as ConversationPlan.SourceAuthor,
				quote: message.text,
				start: 0,
				end: message.text.length,
				role: "reason",
			},
			contribution: {
				id: "reason-inferred",
				text: message.text,
				authoring: "quoted",
				targetId: "thread-a",
			},
		}],
		analysis: {
			questionSetVersion: "conversation-plan-5",
			modelVersion: "fixture",
			status: "applied",
			passes: [],
		},
	}));
	try {
		await h.append();
		let message = entry("more-evidence", "This provider is cheaper.");
		await h.processor.accept(message);
		h.processor.afterMessage();
		await h.processor.idle();
		expect(h.plan.conversationPlan.queue.find(item => item.messageId === message.id)?.status).toBe(
			"failed",
		);
		expect(h.plan.conversationPlan.threads[0]?.contributions).toHaveLength(63);
		await mirrorCard(h.plan, h.processor);
		expect(h.plan.conversationPlan.threads[0]?.contributions).toHaveLength(64);
		expect(h.plan.pendingCardActions).toEqual([]);
		expect(h.errors).toEqual([]);
	} finally {
		await h.close();
	}
});

test("an accepted excerpt reserves the last card slot across another writer and reopen", async () => {
	let h = await setup(9);
	let restored: Plan.Plan | undefined;
	let recovered: ReturnType<typeof createProcessor> | undefined;
	try {
		let reply = await h.correct();
		await h.processor.idle();
		let before = h.snapshot();
		await h.append();
		expect(h.frames.at(-1)).toMatchObject({ ok: false, reason: "full" });
		expect(h.snapshot()).toEqual(before);
		let event = h.plan.conversationPlan.events.find(item => item.id === reply.eventId)!;
		if (event.type !== "option.added") throw new Error("missing accepted option");
		let key = `option:${event.contribution.id}`;
		await h.close();
		restored = await Plan.open(h.plan.id, h.backend, h.server);
		let plan = restored;
		recovered = createProcessor({
			plan,
			exclusive: action => Plan.exclusive(plan, action),
			persist: () => Plan.persistExclusive(plan),
			active: () => true,
			publish() {},
		});
		recovered.setEffects(
			cardEffects(plan, h.server, plan.id, recovered, undefined, {
				chat: plan.chat,
				plan,
				server: h.server,
				room: plan.id,
			}),
		);
		await recovered.idle();
		expect(plan.records.get(h.cardId)?.definition.questions[0]?.options).toHaveLength(10);
		expect(plan.records.get(h.cardId)?.definition.questions[0]?.options.at(-1)?.id).toBe(
			event.contribution.id,
		);
		expect(plan.conversationPlanEffects).toContain(key);
		expect(plan.conversationPlanPendingEffects.some(effect => effect.key === key)).toBe(false);
	} finally {
		recovered?.stop();
		await recovered?.idle();
		if (restored) await Plan.close(restored);
		else await h.close();
	}
});

test("a classifier option ahead of a reserved human option cannot block its delivery", async () => {
	let h = await setup(9);
	try {
		let message = entry("classifier-option", "An inferred provider");
		h.plan.chat.entries.push(message);
		await h.processor.record({
			id: "classifier-option",
			type: "option.added",
			threadId: "thread-a",
			observedThreadVersion: h.plan.conversationPlan.threads[0]!.version,
			origin: "classifier",
			actor: { kind: "classifier" },
			at: 1000,
			source: {
				messageId: message.id,
				author: message.author as ConversationPlan.SourceAuthor,
				quote: message.text,
				start: 0,
				end: message.text.length,
				role: "option",
			},
			contribution: {
				id: "01K0N4W3B7P27CBAEC7A8C8WEA",
				text: message.text,
				authoring: "quoted",
				targetId: "thread-a",
			},
		});
		await h.correct();
		h.processor.setEffects(h.effects);
		await h.processor.idle();
		expect(h.plan.records.get(h.cardId)?.definition.questions[0]?.options.at(-1)?.label).toBe(
			"Use the new provider.",
		);
		expect(h.plan.conversationPlanPendingEffects.filter(effect => effect.kind === "add-option"))
			.toEqual([]);
		expect(h.errors).toEqual([]);
	} finally {
		await h.close();
	}
});

test("an accepted excerpt reserves its label against another writer", async () => {
	let h = await setup(1);
	try {
		await h.correct();
		let before = h.snapshot();
		await h.append("USE THE NEW PROVIDER.");
		expect(h.frames.at(-1)).toMatchObject({ ok: false, reason: "duplicate" });
		expect(h.snapshot()).toEqual(before);
	} finally {
		await h.close();
	}
});

test("a Save after delivery target lookup supersedes the pending human option", async () => {
	let h = await setup(1);
	try {
		let { runEffects } = await import("./effects");
		await h.correct();
		let option = h.plan.conversationPlanPendingEffects.find(effect =>
			effect.kind === "add-option"
		)!;
		let receipts: string[] = [];
		let failures: unknown[] = [];
		await runEffects({
			...h.effects,
			applied: () => false,
			addOption: async (id, input) => {
				await h.save();
				await h.effects.addOption(id, input);
			},
			markApplied: async key => {
				receipts.push(key);
			},
			report: error => failures.push(error),
		}, [option]);
		expect(failures).toEqual([]);
		expect(receipts).toEqual([option.key]);
		expect(h.plan.records.get(h.cardId)?.status).toBe("answered");
		expect(h.plan.records.get(h.cardId)?.definition.questions[0]?.options).toHaveLength(1);
	} finally {
		await h.close();
	}
});

test("refused legacy human option delivery retains pending work without an applied receipt", async () => {
	let h = await setup(10);
	try {
		// Recreate an outbox accepted by the previous implementation at an already-full card.
		let { applyCorrection } = await import("./domain");
		let { effectsFor, runEffects } = await import("./effects");
		let next = applyCorrection(
			h.plan.conversationPlan,
			{
				actionId: "legacy-full",
				threadId: "thread-a",
				expectedVersion: h.plan.conversationPlan.threads[0]!.version,
				change: {
					kind: "add-excerpt",
					messageId: "excerpt",
					start: 0,
					end: "Use the new provider.".length,
					contributionKind: "option",
				},
			},
			{ kind: "member", handle: "bob" },
			1001,
			h.plan.chat.entries,
		);
		h.plan.conversationPlan = next;
		let pending = effectsFor([next.events.at(-1)!], next, undefined, h.plan.records);
		let receipts: string[] = [];
		let failures: unknown[] = [];
		await runEffects({
			...h.effects,
			applied: key => receipts.includes(key),
			markApplied: async key => {
				receipts.push(key);
			},
			report: error => failures.push(error),
		}, pending);
		expect(failures).toHaveLength(1);
		expect(String(failures[0])).toContain("accepted excerpt option: full");
		expect(receipts).toEqual([]);
		expect(h.plan.records.get(h.cardId)?.definition.questions[0]?.options).toHaveLength(10);
	} finally {
		await h.close();
	}
});

test("a legacy over-reserved discussion reopens and permits unrelated commits without more overflow", async () => {
	let h = await setup(1, 62);
	let restored: Plan.Plan | undefined;
	try {
		await h.append();
		let message = entry("legacy-last-reason", "Evidence accepted before reservations existed.");
		let saved = structuredClone(h.plan.persistence.committedSidecar) as {
			[key: string]: JsonValue;
		};
		let legacy = applyInference(h.plan.conversationPlan, {
			id: "legacy-reason",
			type: "reason.added",
			threadId: "thread-a",
			observedThreadVersion: h.plan.conversationPlan.threads[0]!.version,
			origin: "classifier",
			actor: { kind: "classifier" },
			at: 1000,
			source: {
				messageId: message.id,
				author: message.author as ConversationPlan.SourceAuthor,
				quote: message.text,
				start: 0,
				end: message.text.length,
				role: "reason",
			},
			contribution: {
				id: "legacy-reason",
				text: message.text,
				authoring: "quoted",
				targetId: "thread-a",
			},
		}, message);
		saved.conversationPlan = JSON.parse(JSON.stringify(legacy));
		saved.transcript = JSON.parse(JSON.stringify([...h.plan.chat.entries, message]));
		await h.close();
		// Write the prior release's valid durable shape, bypassing today's admission guard.
		let durable = h.plan.persistence;
		await h.storage.collaboration.commit({
			channelId: h.plan.id,
			lease: h.lease,
			expectedRevision: durable.revision,
			operationId: "legacy-over-reservation",
			epoch: durable.committedEpoch,
			sidecar: saved,
			events: [],
			now: new Date(),
		});
		restored = await Plan.open(h.plan.id, h.backend, h.server);
		let pending = structuredClone(restored.pendingCardActions);
		expect(restored.conversationPlan.threads[0]?.contributions).toHaveLength(64);
		restored.chat.entries.push(entry("unrelated-note", "We should update the introduction."));
		await Plan.persist(restored);
		expect(restored.pendingCardActions).toEqual(pending);
		await Questions.addOption(restored, h.server, restored.id, h.ws, {
			kind: "question:option",
			rid: "overflow",
			ts: 0,
			id: h.cardId,
			question: Store.get(restored.questions, h.cardId)!.definition.questions[0]!.id,
			key: "another-option",
			label: "Yet another provider",
		});
		expect(h.frames.at(-1)).toMatchObject({ ok: false, reason: "full" });
		expect(restored.pendingCardActions).toEqual(pending);
		await Plan.close(restored);
		restored = await Plan.open(h.plan.id, h.backend, h.server);
		expect(restored.chat.entries.at(-1)?.id).toBe("unrelated-note");
		expect(restored.pendingCardActions).toEqual(pending);
	} finally {
		if (restored) await Plan.close(restored);
		else await h.close();
	}
});
