import { expect, test } from "bun:test";

import * as room from "../plan/room";

import { openPlan, storedQuestion } from "../testing/plan";
import * as Questions from "./service";
import * as Store from "./store";

import { decided, definition, member, reopen } from "./card-reopen.test-fixtures";

// Whole archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2 callbacks.
test("reopen keeps identity, moves the decision to history, and publishes metadata before asked", async () => {
	let context = await decided();
	let original = room.project(context.plan.document);
	let actor = member();
	let events: Questions.CardEvent[] = [];
	let off = Questions.listen(context.plan, event => events.push(event));
	await reopen(context, actor);
	off();
	expect(actor.frames.at(-1)).toMatchObject({ kind: "question:reopen", ok: true });
	let record = context.plan.records.get(context.id)!;
	expect(record).toMatchObject({
		status: "reopened",
		history: [{
			choices: [context.value.questions[0]!.options[0]!.id],
			owner: "ana",
			at: 1,
		}],
	});
	expect(record.answers).toBeUndefined();
	expect(record.choices).toBeUndefined();
	expect(Store.get(context.plan.questions, context.id)?.settle).toBeUndefined();
	expect(Store.get(context.plan.questions, context.id)?.revision).toBe(0);
	let projected = room.project(context.plan.document);
	expect(projected).toContain('status="reopened"');
	expect(projected).toContain(
		`<Previous choices="${context.value.questions[0]!.options[0]!.id}" by="ana"`,
	);
	expect(projected).not.toContain("<Answer");
	expect(projected).not.toBe(original);
	expect(context.broadcasts.slice(-3).map(frame => frame.kind)).toEqual([
		"plan:update",
		"question:meta",
		"question:asked",
	]);
	expect(events).toEqual([{ kind: "reopened", id: context.id, actor: "ben" }]);
});

test("a failed reopen commit preserves the answer, tombstone and history; retry commits once", async () => {
	let context = await decided();
	let question = context.value.questions[0]!;
	context.plan.questions.closed.set(context.id, {
		result: {
			status: "answered",
			answers: [{
				question: question.question,
				choices: [question.options[0]!.label],
				optionIds: [question.options[0]!.id],
			}],
			resolver: "ana",
		},
		revision: 1,
		expires: Date.now() + 60_000,
	});
	let before = room.project(context.plan.document);
	let stored = await context.storage.collaboration.load(context.channel.id, context.now);
	let old = context.plan.records.get(context.id)!;
	let closed = context.plan.questions.closed.get(context.id);
	let frames = context.broadcasts.length;
	let events: Questions.CardEvent[] = [];
	let off = Questions.listen(context.plan, event => events.push(event));
	let original = context.storage.collaboration.commit;
	(context.storage.collaboration as { commit: typeof original }).commit = async () => {
		throw new Error("storage unavailable");
	};
	try {
		let actor = await reopen(context);
		expect(actor.frames.at(-1)).toMatchObject({ ok: false, reason: "resolving" });
	} finally {
		(context.storage.collaboration as { commit: typeof original }).commit = original;
	}
	expect(context.plan.records.get(context.id)).toEqual(old);
	expect(context.plan.questions.closed.get(context.id)).toBe(closed);
	expect(Store.get(context.plan.questions, context.id)).toBeUndefined();
	expect(room.project(context.plan.document)).toBe(before);
	expect(context.broadcasts).toHaveLength(frames);
	expect(events).toEqual([]);
	expect((await context.storage.collaboration.load(context.channel.id, context.now))?.sidecar)
		.toEqual(stored?.sidecar);
	await reopen(context);
	expect(context.plan.records.get(context.id)?.history).toHaveLength(1);
	expect(context.plan.questions.closed.has(context.id)).toBe(false);
	off();
});

test("duplicate reopen and reopen after discard are refused", async () => {
	let context = await decided();
	let first = member("ben");
	let second = member("cy");
	await Promise.all([
		reopen(context, first),
		reopen(context, second),
	]);
	expect([first, second].filter(actor => actor.frames.at(-1)?.ok === true)).toHaveLength(1);
	expect(context.plan.records.get(context.id)?.history).toHaveLength(1);
	await Questions.discard(context.plan, context.server, "test", first.ws, {
		kind: "question:discard",
		ts: 0,
		rid: "discard",
		id: context.id,
	});
	await reopen(context, second);
	expect(second.frames.at(-1)).toMatchObject({ ok: false, reason: "not-decided" });
});

test("a queued discard follows the reopened draft announcement", async () => {
	let context = await decided();
	let actor = member("ben");
	let discarder = member("cy");
	let original = context.storage.collaboration.commit;
	let entered = Promise.withResolvers<void>();
	let release = Promise.withResolvers<void>();
	let commits = 0;
	(context.storage.collaboration as { commit: typeof original }).commit = async input => {
		if (++commits === 1) {
			entered.resolve();
			await release.promise;
		}
		return original(input);
	};
	try {
		let reopening = reopen(context, actor);
		await entered.promise;
		let discarding = Questions.discard(context.plan, context.server, "test", discarder.ws, {
			kind: "question:discard",
			ts: 0,
			rid: "discard",
			id: context.id,
		});
		release.resolve();
		await Promise.all([reopening, discarding]);
	} finally {
		release.resolve();
		(context.storage.collaboration as { commit: typeof original }).commit = original;
	}
	let events = context.broadcasts.map(
		frame => [frame.kind, (frame.meta as { status?: string })?.status],
	);
	let asked = events.findIndex(([kind]) => kind === "question:asked");
	let discarded = events.findIndex(([kind, status]) =>
		kind === "question:meta" && status === "discarded"
	);
	expect(asked).toBeGreaterThan(-1);
	expect(discarded).toBeGreaterThan(asked);
	expect(context.plan.records.get(context.id)?.status).toBe("discarded");
});

test("a failed metadata broadcast after commit still announces the draft and emits the event", async () => {
	let context = await decided();
	let actor = member();
	let events: Questions.CardEvent[] = [];
	let off = Questions.listen(context.plan, event => events.push(event));
	context.breakRelay("question:meta");
	await reopen(context, actor);
	off();
	expect(actor.frames.at(-1)).toMatchObject({ ok: true });
	expect(context.broadcasts.some(frame => frame.kind === "question:asked")).toBe(true);
	expect(events).toEqual([{ kind: "reopened", id: context.id, actor: "ben" }]);
	expect(context.plan.records.get(context.id)?.status).toBe("reopened");
});

test("restore refuses a draft whose definition reorders the record's questions", async () => {
	let value = definition(2);
	let reversed = { questions: value.questions.toReversed() };
	await expect(openPlan("", {
		questions: [{ id: "w", definition: value, status: "open" }],
		openQuestions: [{
			id: "w",
			definition: reversed,
			model: storedQuestion(reversed),
			revision: 0,
		}],
	})).rejects.toThrow(/question records disagree with their drafts/);
});

test("reopen refuses to clear an answer with no ID or text to preserve", async () => {
	let value = definition(2);
	let first = value.questions[0]!;
	let context = await decided(value, { [first.id]: "Option 1" }, [first.options[0]!.id]);
	let before = room.project(context.plan.document);
	let actor = await reopen(context);
	expect(actor.frames.at(-1)).toMatchObject({ ok: false, reason: "resolving" });
	expect(context.plan.records.get(context.id)?.status).toBe("answered");
	expect(room.project(context.plan.document)).toBe(before);
});

test("an older option summary without saved IDs stays text even when its label matches", async () => {
	let value = definition();
	let question = value.questions[0]!;
	let context = await decided(value, { [question.id]: question.options[0]!.label }, []);
	await reopen(context);
	expect(context.plan.records.get(context.id)?.history[0]).toEqual({
		choices: [],
		answers: { [question.id]: question.options[0]!.label },
		owner: "ana",
		at: 1,
	});
	expect(room.project(context.plan.document)).toContain(
		`<Previous value="${question.options[0]!.label}"`,
	);
});
