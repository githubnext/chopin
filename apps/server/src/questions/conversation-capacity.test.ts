import { expect, spyOn, test } from "bun:test";
import * as Questions from "./service";
import * as Store from "./store";
import * as Plan from "../plan/service";
import * as Room from "../plan/room";
import { openPlan } from "../testing/plan";
import { createProcessor } from "../conversation-plan/service";
import { mirrorCard } from "../conversation-plan/card-mirror-runner";
import { MAX_EVENTS } from "../conversation-plan/validation";
import { applyEvent } from "../conversation-plan/events";
import { opened, unlinked } from "../conversation-plan/service.test-fixtures";
import type { Socket } from "../wire";

async function ask(context: Awaited<ReturnType<typeof openPlan>>) {
	let created = Promise.withResolvers<void>();
	let waiting = Questions.ask(
		context.plan,
		context.server,
		context.plan.id,
		Questions.identify({
			questions: [{
				header: "Hosting",
				question: "Where should we host?",
				multiple: false,
				options: [{ label: "Managed service", description: "" }],
			}],
		}),
		undefined,
		created.resolve,
	);
	await Promise.race([created.promise, waiting]);
	return [...context.plan.records.values()].at(-1)!;
}

function fill(context: Awaited<ReturnType<typeof openPlan>>, remaining: number) {
	// Restoration replays all 4096 events, so keep filler IDs short and leave card threads untouched.
	let threadId = "filler";
	let state = applyEvent(context.plan.conversationPlan, {
		id: "filler:opened",
		type: "thread.opened",
		threadId,
		observedThreadVersion: 0,
		origin: "planner",
		actor: { kind: "agent" },
		at: 0,
		question: "Filler thread?",
	});
	let thread = state.threads.at(-1)!;
	while (state.events.length < MAX_EVENTS - remaining) {
		state.events.push({
			id: String(state.events.length),
			type: "thread.discarded",
			threadId: thread.id,
			observedThreadVersion: thread.version++,
			origin: "human",
			actor: { kind: "member", handle: "ana" },
			at: state.events.length,
		});
		thread.status = "discarded";
		state.revision++;
	}
	context.plan.conversationPlan = state;
}

function member(context: Awaited<ReturnType<typeof openPlan>>) {
	let frames: Array<Record<string, unknown>> = [];
	let ws = {
		data: { handle: "ana", client: "client-ana", room: context.plan.id },
		send(raw: string) {
			frames.push(JSON.parse(raw));
		},
		publish() {},
	} as unknown as Socket;
	return { ws, frames };
}

async function select(context: Awaited<ReturnType<typeof openPlan>>, ws: Socket, id: string) {
	let entry = Store.get(context.plan.questions, id)!;
	let model = entry.model.fork();
	let question = entry.definition.questions[0]!;
	model.api.val([question.id, "choice"]).set(question.options[0]!.id);
	let patch = model.api.flush()!;
	await Questions.edit(context.plan, ws, {
		kind: "question:edit",
		ts: 0,
		rid: "select",
		id,
		patch: [...patch.toBinary()],
	});
}

for (let action of ["submit", "cancel"] as const) {
	test(`full event history rejects linked ${action} without changing authority or draft`, async () => {
		let context = await openPlan();
		try {
			let record = await ask(context);
			let { ws, frames } = member(context);
			if (action === "submit") await select(context, ws, record.id);
			let accepted = context.plan.records.get(record.id);
			fill(context, 0);
			await Plan.persist(context.plan);
			let source = Room.project(context.plan.document);
			let epoch = context.plan.document.epoch;
			let seq = context.plan.document.seq;
			let draft = Store.snapshot(context.plan.questions, record.id);
			let revision = context.plan.persistence.revision;
			frames.length = 0;
			if (action === "submit") {
				await Questions.submit(context.plan, context.server, context.plan.id, ws, {
					kind: "question:submit",
					ts: 0,
					rid: action,
					id: record.id,
					revision: Store.get(context.plan.questions, record.id)!.revision,
				});
			} else {
				await Questions.cancel(context.plan, context.server, context.plan.id, ws, {
					kind: "question:cancel",
					ts: 0,
					rid: action,
					id: record.id,
				});
			}
			expect(context.plan.records.get(record.id)).toEqual(accepted);
			expect(Store.snapshot(context.plan.questions, record.id)).toEqual(draft);
			expect(Store.get(context.plan.questions, record.id)?.claim).toBeUndefined();
			expect(Room.project(context.plan.document)).toBe(source);
			expect([context.plan.document.epoch, context.plan.document.seq]).toEqual([epoch, seq]);
			expect(context.plan.pendingCardActions).toEqual([]);
			expect(context.plan.persistence.revision).toBe(revision);
			expect(frames).toMatchObject([{
				kind: "session:error",
				rid: action,
				message: "Conversation history is full",
			}]);
		} finally {
			await Plan.close(context.plan);
		}
	});
}

for (let action of ["submit", "cancel"] as const) {
	test(`the last event slot is reserved for ${action} across restart`, async () => {
		let context = await openPlan();
		let errors: unknown[] = [];
		let processor: ReturnType<typeof createProcessor> | undefined;
		try {
			let first = await ask(context);
			let second = await ask(context);
			let { ws, frames } = member(context);
			if (action === "submit") await select(context, ws, first.id);
			fill(context, 1);
			if (action === "submit") {
				await Questions.submit(context.plan, context.server, context.plan.id, ws, {
					kind: "question:submit",
					ts: 0,
					rid: "first",
					id: first.id,
					revision: Store.get(context.plan.questions, first.id)!.revision,
				});
			} else {
				await Questions.cancel(context.plan, context.server, context.plan.id, ws, {
					kind: "question:cancel",
					ts: 0,
					rid: "first",
					id: first.id,
				});
			}
			expect(context.plan.pendingCardActions).toHaveLength(1);
			await Questions.cancel(context.plan, context.server, context.plan.id, ws, {
				kind: "question:cancel",
				ts: 0,
				rid: "second",
				id: second.id,
			});
			expect(context.plan.records.get(second.id)?.status).toBe("open");
			expect(context.plan.pendingCardActions).toHaveLength(1);
			expect(frames.at(-1)).toMatchObject({ kind: "session:error", rid: "second" });
			processor = createProcessor({
				plan: context.plan,
				active: () => true,
				exclusive: action => Plan.exclusive(context.plan, action),
				persist: () => Plan.persistExclusive(context.plan),
				publish() {},
				onError: error => errors.push(error),
				interpret: async input => ({
					...unlinked(),
					events: [opened(input.message)],
					analysis: { ...unlinked().analysis, status: "applied" },
				}),
			});
			let previous = context.plan.conversationPlan;
			let fatal = spyOn(context.plan.persistence, "fatal");
			try {
				await expect(processor.record({
					id: "unrelated",
					type: "thread.opened",
					threadId: "unrelated",
					observedThreadVersion: 0,
					origin: "planner",
					actor: { kind: "agent" },
					at: 0,
					question: "Another question?",
				})).rejects.toThrow("Conversation history is full");
				expect(context.plan.conversationPlan).toBe(previous);
				expect(fatal).not.toHaveBeenCalled();
			} finally {
				fatal.mockRestore();
			}
			await processor.accept({
				id: "m-capacity",
				text: "Can we ship?",
				ts: 1000,
				author: { kind: "member", handle: "ana" },
			});
			processor.afterMessage();
			await processor.idle();
			expect(errors).toEqual([]);
			expect(context.plan.conversationPlan.queue).toMatchObject([{
				messageId: "m-capacity",
				status: "failed",
			}]);
			expect(context.plan.conversationPlan.events).toHaveLength(MAX_EVENTS - 1);
			let unlinkedCard = await ask(context);
			expect(unlinkedCard.threadId).toBeUndefined();
			processor.stop();
			await processor.idle();
			await Plan.close(context.plan);
			context.plan = await Plan.open(context.plan.id, context.backend, context.server);
			expect(context.plan.records.get(unlinkedCard.id)?.threadId).toBeUndefined();
			processor = createProcessor({
				plan: context.plan,
				active: () => true,
				exclusive: action => Plan.exclusive(context.plan, action),
				persist: () => Plan.persistExclusive(context.plan),
				publish() {},
				interpret: async input => ({
					...unlinked(),
					events: [opened(input.message)],
					analysis: { ...unlinked().analysis, status: "applied" },
				}),
			});
			await mirrorCard(context.plan, processor);
			expect(context.plan.pendingCardActions).toEqual([]);
			expect(context.plan.conversationPlan.events).toHaveLength(MAX_EVENTS);
			expect(context.plan.conversationPlan.events.at(-1)?.id).toBe(
				action === "submit" ? `card:${first.id}:decided:1` : `card:${first.id}:discarded`,
			);
			await processor.accept({
				id: "m-full",
				text: "Can we ship?",
				ts: 1001,
				author: { kind: "member", handle: "ana" },
			});
			processor.afterMessage();
			await processor.idle();
			expect(context.plan.conversationPlan.queue.at(-1)).toMatchObject({
				messageId: "m-full",
				status: "failed",
				error: "Conversation history is full",
			});
			if (action === "submit") {
				await select(context, ws, unlinkedCard.id);
				await Questions.submit(context.plan, context.server, context.plan.id, ws, {
					kind: "question:submit",
					ts: 0,
					rid: "unlinked",
					id: unlinkedCard.id,
					revision: Store.get(context.plan.questions, unlinkedCard.id)!.revision,
				});
			} else {
				await Questions.cancel(context.plan, context.server, context.plan.id, ws, {
					kind: "question:cancel",
					ts: 0,
					rid: "unlinked",
					id: unlinkedCard.id,
				});
			}
			expect(context.plan.records.get(unlinkedCard.id)?.status).toBe(
				action === "submit" ? "answered" : "cancelled",
			);
			expect(context.plan.pendingCardActions).toEqual([]);
		} finally {
			processor?.stop();
			await processor?.idle();
			await Plan.close(context.plan);
		}
	}, 20_000);
}

test("ordinary asks and startup backfill preserve reserved mirror slots", async () => {
	let context = await openPlan();
	try {
		let first = await ask(context);
		let { ws } = member(context);
		fill(context, 3);
		await Questions.cancel(context.plan, context.server, context.plan.id, ws, {
			kind: "question:cancel",
			ts: 0,
			rid: "cancel",
			id: first.id,
		});
		let ordinary = await ask(context);
		expect(ordinary.threadId).toBeUndefined();
		expect(context.plan.conversationPlan.events).toHaveLength(MAX_EVENTS - 3);
		await Plan.close(context.plan);
		context.plan = await Plan.open(context.plan.id, context.backend, context.server);
		expect(context.plan.records.get(ordinary.id)?.threadId).toBeUndefined();
		expect(context.plan.conversationPlan.events).toHaveLength(MAX_EVENTS - 3);
		expect(context.plan.pendingCardActions).toHaveLength(1);
	} finally {
		await Plan.close(context.plan);
	}
}, 20_000);
