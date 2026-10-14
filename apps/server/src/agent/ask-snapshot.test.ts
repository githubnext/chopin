import { afterEach, expect, test } from "bun:test";

import { type DocumentRoom, documentTools } from "./tools";
import * as Plan from "../plan/service";
import * as Questions from "../questions/service";
import * as Store from "../questions/store";
import { hostInputRoom } from "../testing/decisions";

let opened: Array<Awaited<ReturnType<typeof hostInputRoom>>> = [];

afterEach(async () => {
	for (let fixture of opened.splice(0)) await fixture.close();
});

async function fixture() {
	let host = await hostInputRoom();
	opened.push(host);
	let created = Promise.withResolvers<void>();
	let room: DocumentRoom = {
		...host.room,
		persist: () => Plan.persist(host.plan),
		exclusive: action => Plan.exclusive(host.plan, action),
		publish: mutation => Plan.publish(host.plan, host.server, host.plan.id, mutation),
		anchors: () => created.resolve(),
		changes() {},
	};
	let controller = new AbortController();
	let owner = { signal: controller.signal, revalidate: async () => true };
	let ask = (withOwner = true, abortSignal?: AbortSignal, count = 1) =>
		documentTools.ask.execute!({
			revision: host.plan.revision,
			questions: Array.from({ length: count }, (_, index) => ({
				header: `Rollout ${index + 1}`,
				question: `How should we deploy part ${index + 1}?`,
				options: [{ label: "Canary", description: "Limit exposure." }],
				multiple: false,
				blocks: [],
			})),
		}, {
			context: { room, ...(withOwner ? { owner } : {}) },
			toolCallId: "ask",
			messages: [],
			...(abortSignal ? { abortSignal } : {}),
		} as never);
	let cards = async (count = 1) => {
		await created.promise;
		let found = Store.outstanding(host.plan.questions);
		if (found.length !== count) throw new Error("questions were not created");
		return found;
	};
	let card = async () => (await cards())[0]!;
	return { host, room, owner, controller, ask, card, cards };
}

async function answered(input: Awaited<ReturnType<typeof fixture>>, withOwner = true) {
	let pending = input.ask(withOwner);
	let question = await input.card();
	await input.host.answer(question.id, [0]);
	let response = await pending;
	if (typeof response !== "string") throw new Error("ask returned no text");
	return JSON.parse(response);
}

test("ask returns the saved answer with a read_plan-shaped current document", async () => {
	let { host, room, ask, card } = await fixture();
	let pending = ask();
	let question = await card();
	await host.answer(question.id, [0]);
	let response = await pending;
	if (typeof response !== "string") throw new Error("ask returned no text");
	let result = JSON.parse(response);
	expect(result.outcomes).toEqual([{
		status: "answered",
		answered_by: "reader",
		answers: expect.any(Array),
	}]);
	let read = await documentTools.read_plan.execute!({}, {
		context: { room },
		toolCallId: "read",
		messages: [],
	} as never);
	if (typeof read !== "string") throw new Error("read returned no text");
	expect(result.current_plan).toEqual(JSON.parse(read));
	expect(result.current_plan.document.id).toBe(room.id);
	expect(result.current_plan.questions).toEqual(expect.arrayContaining([
		expect.objectContaining({ id: question.id, status: "answered", answered_by: "reader" }),
	]));
});

test("ask waits for the answer's durable commit before taking a snapshot", async () => {
	let input = await fixture();
	let pending = input.ask();
	let question = await input.card();
	let saving = Promise.withResolvers<void>();
	let release = Promise.withResolvers<void>();
	let commit = input.host.storage.collaboration.commit;
	let lookups = 0;
	let get = input.host.storage.channels.get;
	input.host.storage.channels.get = id => {
		lookups++;
		return get(id);
	};
	input.host.storage.collaboration.commit = async change => {
		if (Store.get(input.host.plan.questions, question.id)?.claim === "submit") {
			saving.resolve();
			await release.promise;
		}
		return commit(change);
	};
	let submission = input.host.answer(question.id, [0]);
	try {
		await saving.promise;
		expect(input.host.plan.records.get(question.id)?.status).toBe("open");
		expect(lookups).toBe(0);
	} finally {
		release.resolve();
	}
	await submission;
	let response = await pending;
	if (typeof response !== "string") throw new Error("ask returned no text");
	let result = JSON.parse(response);
	expect(result.outcomes[0].status).toBe("answered");
	expect(result.current_plan.questions).toEqual(expect.arrayContaining([
		expect.objectContaining({ id: question.id, status: "answered" }),
	]));
});

test("ask captures a queued edit and its normal edit guard still rejects stale revisions", async () => {
	let input = await fixture();
	let revalidating = Promise.withResolvers<void>();
	let release = Promise.withResolvers<boolean>();
	input.owner.revalidate = async () => {
		revalidating.resolve();
		return release.promise;
	};
	let pending = input.ask();
	let question = await input.card();
	await input.host.answer(question.id, [0]);
	await revalidating.promise;
	let oldRevision = input.host.plan.revision;
	let edit = await documentTools.edit_plan.execute!({
		revision: oldRevision,
		operations: [{ op: "insert_root", source: "## Rollout\n\nUse a canary.\n" }],
	}, { context: { room: input.room }, toolCallId: "human-edit", messages: [] } as never);
	if (typeof edit !== "string") throw new Error("edit returned no text");
	expect(JSON.parse(edit).ok).toBe(true);
	release.resolve(true);
	let response = await pending;
	if (typeof response !== "string") throw new Error("ask returned no text");
	let result = JSON.parse(response);
	expect(result.current_plan.revision).toBe(input.host.plan.revision);
	expect(result.current_plan.source).toContain("Use a canary.");
	let continuation = await documentTools.edit_plan.execute!({
		revision: result.current_plan.revision,
		operations: [{ op: "insert_root", source: "## Next step\n\nWatch the canary.\n" }],
	}, { context: { room: input.room }, toolCallId: "continuation", messages: [] } as never);
	if (typeof continuation !== "string") throw new Error("edit returned no text");
	expect(JSON.parse(continuation)).toMatchObject({
		ok: true,
		anchors_pending: expect.arrayContaining([expect.objectContaining({ widget: question.id })]),
	});
	let stale = await documentTools.edit_plan.execute!({
		revision: oldRevision,
		operations: [{ op: "insert_root", source: "## Stale\n" }],
	}, { context: { room: input.room }, toolCallId: "stale-edit", messages: [] } as never);
	if (typeof stale !== "string") throw new Error("edit returned no text");
	expect(JSON.parse(stale)).toMatchObject({ ok: false, reason: "stale" });
});

test("ask includes a snapshot for a mixed answered and cancelled batch", async () => {
	let input = await fixture();
	let pending = input.ask(true, undefined, 2);
	let [first, second] = await input.cards(2);
	await input.host.answer(first!.id, [0]);
	await Questions.cancel(input.host.plan, input.host.server, input.host.plan.id, input.host.ws, {
		kind: "question:cancel",
		rid: "cancel",
		ts: 0,
		id: second!.id,
	});
	let response = await pending;
	if (typeof response !== "string") throw new Error("ask returned no text");
	let result = JSON.parse(response);
	expect(result.outcomes).toEqual([
		{ status: "answered", answered_by: "reader", answers: expect.any(Array) },
		{ status: "cancelled", cancelled_by: "reader" },
	]);
	expect(result.current_plan.questions).toEqual(expect.arrayContaining([
		expect.objectContaining({ id: first!.id, status: "answered" }),
		expect.objectContaining({ id: second!.id, status: "cancelled" }),
	]));
});

test("ask omits the snapshot when all cancelled, missing an owner, or no longer authorized", async () => {
	let cancelled = await fixture();
	let pending = cancelled.ask();
	let question = await cancelled.card();
	await Questions.cancel(
		cancelled.host.plan,
		cancelled.host.server,
		cancelled.host.plan.id,
		cancelled.host.ws,
		{ kind: "question:cancel", rid: "cancel", ts: 0, id: question.id },
	);
	let cancelledText = await pending;
	if (typeof cancelledText !== "string") throw new Error("ask returned no text");
	expect(JSON.parse(cancelledText)).toEqual({
		outcomes: [{ status: "cancelled", cancelled_by: "reader" }],
	});
	let withoutOwner = await fixture();
	expect(await answered(withoutOwner, false)).toEqual({
		outcomes: [{ status: "answered", answered_by: "reader", answers: expect.any(Array) }],
	});
	for (
		let revalidate of [async () => false, async () => {
			throw new Error("revoked");
		}]
	) {
		let input = await fixture();
		input.owner.revalidate = revalidate;
		expect(await answered(input)).toEqual({
			outcomes: [{ status: "answered", answered_by: "reader", answers: expect.any(Array) }],
		});
	}
});

for (let kind of ["owner", "tool"] as const) {
	test(`ask omits the snapshot when ${kind} aborts during identity lookup`, async () => {
		let input = await fixture();
		let lookingUp = Promise.withResolvers<void>();
		let release = Promise.withResolvers<void>();
		let get = input.host.storage.channels.get;
		input.host.storage.channels.get = async id => {
			lookingUp.resolve();
			await release.promise;
			return get(id);
		};
		let tool = new AbortController();
		let pending = input.ask(true, tool.signal);
		let question = await input.card();
		await input.host.answer(question.id, [0]);
		await lookingUp.promise;
		if (kind === "owner") input.controller.abort(new Error("credential expired"));
		else tool.abort();
		release.resolve();
		let response = await pending;
		if (typeof response !== "string") throw new Error("ask returned no text");
		expect(JSON.parse(response)).toEqual({
			outcomes: [{ status: "answered", answered_by: "reader", answers: expect.any(Array) }],
		});
	});
}

test("ask omits the snapshot when its owner aborts while waiting for the room queue", async () => {
	let input = await fixture();
	let queued = Promise.withResolvers<void>();
	let release = Promise.withResolvers<void>();
	input.room.exclusive = async action => {
		queued.resolve();
		await release.promise;
		return Plan.exclusive(input.host.plan, action);
	};
	let pending = input.ask();
	let question = await input.card();
	await input.host.answer(question.id, [0]);
	await queued.promise;
	input.controller.abort(new Error("credential expired"));
	release.resolve();
	let response = await pending;
	if (typeof response !== "string") throw new Error("ask returned no text");
	expect(JSON.parse(response)).toEqual({
		outcomes: [{ status: "answered", answered_by: "reader", answers: expect.any(Array) }],
	});
});
