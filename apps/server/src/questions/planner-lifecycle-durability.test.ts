import { expect, spyOn, test } from "bun:test";
import * as Questions from "./service";
import * as Store from "./store";
import * as Plan from "../plan/service";
import * as Room from "../plan/room";
import { openPlan } from "../testing/plan";
import { createProcessor } from "../conversation-plan/service";
import { mirrorCard } from "../conversation-plan/card-mirror-runner";
import { replay } from "../conversation-plan/domain";
import { MAX_EVENTS } from "../conversation-plan/validation";
import type { ConversationPlan } from "@chopin/protocol";
import type { Socket } from "../wire";

function definition() {
	return Questions.identify({
		questions: [{
			header: "Hosting",
			question: "Where should we host?",
			multiple: false,
			options: [{ label: "Managed service", description: "" }],
		}],
	});
}

async function ask(context: Awaited<ReturnType<typeof openPlan>>) {
	let created = Promise.withResolvers<void>();
	let waiting = Questions.ask(
		context.plan,
		context.server,
		context.plan.id,
		definition(),
		undefined,
		created.resolve,
	);
	await Promise.race([created.promise, waiting]);
	let record = [...context.plan.records.values()].at(-1)!;
	return { record, waiting };
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

test("ordinary Planner asks remain available after conversation thread capacity", async () => {
	let context = await openPlan();
	try {
		for (let index = 0; index < 21; index++) await ask(context);
		expect(context.plan.records.size).toBe(21);
		expect(context.plan.questions.open.size).toBe(21);
		expect(context.plan.conversationPlan.threads).toHaveLength(20);
		let last = [...context.plan.records.values()].at(-1)!;
		expect(last.threadId).toBeUndefined();
		expect(Room.questionnaireProjections(context.plan.document).find(card => card.id === last.id))
			.not.toHaveProperty("thread");
		await Plan.close(context.plan);
		context.plan = await Plan.open(context.plan.id, context.backend, context.server);
		expect(context.plan.records.size).toBe(21);
		expect(context.plan.questions.open.size).toBe(21);
	} finally {
		await Plan.close(context.plan);
	}
});

test("failed Planner ask commits leave no live or durable card or thread", async () => {
	let context = await openPlan();
	let commit = spyOn(context.storage.collaboration, "commit")
		.mockRejectedValueOnce(new Error("storage unavailable"));
	try {
		await expect(Questions.ask(context.plan, context.server, context.plan.id, definition()))
			.rejects.toThrow("storage unavailable");
		expect(context.plan.records.size).toBe(0);
		expect(context.plan.questions.open.size).toBe(0);
		expect(context.plan.conversationPlan.threads).toEqual([]);
		expect(Room.project(context.plan.document)).toBe("");
		expect(context.broadcasts).toEqual([]);
		let saved = await context.storage.collaboration.load(context.plan.id, new Date());
		expect(saved?.sidecar ?? saved?.snapshot?.sidecar)
			.toMatchObject({ questions: [], openQuestions: [] });
	} finally {
		commit.mockRestore();
		await Plan.close(context.plan);
	}
});

test("ordinary Planner asks remain available after conversation event capacity", async () => {
	let context = await openPlan();
	try {
		await ask(context);
		let thread = context.plan.conversationPlan.threads[0]!;
		let remaining = MAX_EVENTS - context.plan.conversationPlan.events.length;
		let events: ConversationPlan.Event[] = Array.from({ length: remaining }, (_, index) => ({
			id: `discard-history:${index}`,
			type: "thread.discarded",
			threadId: thread.id,
			observedThreadVersion: thread.version + index,
			origin: "human",
			actor: { kind: "member", handle: "ana" },
			at: index,
		}));
		context.plan.conversationPlan = replay([...context.plan.conversationPlan.events, ...events]);
		let state = context.plan.conversationPlan;
		let { record } = await ask(context);
		expect(record.threadId).toBeUndefined();
		expect(context.plan.conversationPlan).toBe(state);
		expect(context.plan.conversationPlan.events).toHaveLength(MAX_EVENTS);
		expect(context.plan.records.size).toBe(2);
		expect(context.plan.questions.open.size).toBe(2);
	} finally {
		await Plan.close(context.plan);
	}
}, 20_000);

test("cancellation keeps a linked draft private until commit and mirrors discard after restart", async () => {
	let context = await openPlan();
	let { record, waiting } = await ask(context);
	let { ws, frames } = member(context);
	let entered = Promise.withResolvers<void>();
	let release = Promise.withResolvers<void>();
	let commit = context.storage.collaboration.commit.bind(context.storage.collaboration);
	let held = spyOn(context.storage.collaboration, "commit").mockImplementation(async input => {
		entered.resolve();
		await release.promise;
		return commit(input);
	});
	let before = Room.project(context.plan.document);
	let events: Questions.CardEvent[] = [];
	let off = Questions.listen(context.plan, event => events.push(event));
	let cancelled = Questions.cancel(context.plan, context.server, context.plan.id, ws, {
		kind: "question:cancel",
		ts: 0,
		rid: "cancel",
		id: record.id,
	});
	try {
		await entered.promise;
		expect(context.plan.records.get(record.id)?.status).toBe("open");
		expect(Store.snapshot(context.plan.questions, record.id).open).toBe(true);
		expect(Room.project(context.plan.document)).toBe(before);
		expect(context.plan.pendingCardActions).toEqual([]);
		expect(events).toEqual([]);
		expect(frames).toEqual([]);
		release.resolve();
		await cancelled;
		expect(await waiting).toEqual([{ status: "cancelled", resolver: "ana" }]);
		expect(context.plan.pendingCardActions).toMatchObject([{
			kind: "discarded",
			cardId: record.id,
			threadId: record.threadId,
			actor: "ana",
		}]);
		expect(events).toMatchObject([{ kind: "discarded", id: record.id }]);
		held.mockRestore();
		await Plan.close(context.plan);
		context.plan = await Plan.open(context.plan.id, context.backend, context.server);
		let processor = createProcessor({
			plan: context.plan,
			active: () => true,
			exclusive: action => Plan.exclusive(context.plan, action),
			persist: () => Plan.persistExclusive(context.plan),
			publish() {},
		});
		try {
			await mirrorCard(context.plan, processor);
			await mirrorCard(context.plan, processor);
			expect(context.plan.pendingCardActions).toEqual([]);
			expect(
				context.plan.conversationPlan.threads.find(thread => thread.id === record.threadId)
					?.status,
			).toBe("discarded");
			expect(
				context.plan.conversationPlan.events.filter(event => event.type === "thread.discarded"),
			)
				.toHaveLength(1);
		} finally {
			processor.stop();
			await processor.idle();
		}
	} finally {
		release.resolve();
		await cancelled;
		held.mockRestore();
		off();
		await Plan.close(context.plan);
	}
});

test("failed cancellation releases its claim and preserves the accepted draft", async () => {
	let context = await openPlan();
	let { record, waiting } = await ask(context);
	let { ws, frames } = member(context);
	let entry = Store.get(context.plan.questions, record.id)!;
	let model = entry.model.fork();
	let question = entry.definition.questions[0]!;
	model.api.val([question.id, "choice"]).set(question.options[0]!.id);
	let patch = model.api.flush();
	if (!patch) throw new Error("selection produced no patch");
	await Questions.edit(context.plan, ws, {
		kind: "question:edit",
		ts: 0,
		rid: "select",
		id: record.id,
		patch: [...patch.toBinary()],
	});
	let draft = Store.snapshot(context.plan.questions, record.id);
	frames.length = 0;
	let source = Room.project(context.plan.document);
	let commit = spyOn(context.storage.collaboration, "commit")
		.mockRejectedValueOnce(new Error("storage unavailable"));
	try {
		await Questions.cancel(context.plan, context.server, context.plan.id, ws, {
			kind: "question:cancel",
			ts: 0,
			rid: "failed-cancel",
			id: record.id,
		});
		expect(context.plan.records.get(record.id)?.status).toBe("open");
		expect(Store.get(context.plan.questions, record.id)?.claim).toBeUndefined();
		expect(Store.snapshot(context.plan.questions, record.id)).toEqual(draft);
		expect(Room.project(context.plan.document)).toBe(source);
		expect(context.plan.pendingCardActions).toEqual([]);
		expect(frames).toMatchObject([{ kind: "session:error", rid: "failed-cancel" }]);
		await Questions.cancel(context.plan, context.server, context.plan.id, ws, {
			kind: "question:cancel",
			ts: 0,
			rid: "retry-cancel",
			id: record.id,
		});
		expect(await waiting).toEqual([{ status: "cancelled", resolver: "ana" }]);
		expect(context.plan.pendingCardActions).toHaveLength(1);
	} finally {
		commit.mockRestore();
		await Plan.close(context.plan);
	}
});
