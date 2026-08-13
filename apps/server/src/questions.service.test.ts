import { afterEach, expect, test } from "bun:test";

import * as Question from "@chopin/question";

import * as Questions from "./questions/service";
import * as Store from "./questions/store";
import * as room from "./plan/room";
import * as Service from "./plan/service";
import { openPlan } from "./testing/plan";

import type { Server } from "bun";
import type { Plan } from "./plan/service";
import type { Socket, SocketData } from "./wire";

let plans: Plan[] = [];

afterEach(async () => {
	for (let plan of plans) await Service.close(plan);
	plans = [];
});

async function opened(source = ""): Promise<Plan> {
	let { plan } = await openPlan(source);
	plans.push(plan);
	return plan;
}

function definition(count = 1) {
	return Questions.identify({
		questions: Array.from({ length: count }, (_, index) => ({
			header: `Decision ${index + 1}`,
			question: `What should decision ${index + 1} be?`,
			multiple: false,
			options: [{ label: "Choose this", description: "The selected option." }],
		})),
	});
}

function asking(
	plan: Plan,
	server: Server<SocketData>,
	value: ReturnType<typeof definition>,
	placement?: Parameters<typeof Questions.ask>[4],
) {
	let created = Promise.withResolvers<void>();
	let waiting = Questions.ask(plan, server, "test", value, placement, created.resolve);
	return { created: created.promise, waiting };
}

async function answer(plan: Plan): Promise<void> {
	for (let record of [...plan.records.values()].toReversed()) {
		let item = record.definition.questions[0]!;
		let opened = Store.snapshot(plan.questions, record.id);
		if (!opened.open) throw new Error("question was not open");
		let model = Question.crdt.Model.fromBinary(new Uint8Array(opened.model))
			.fork() as unknown as Question.Model;
		model.api.val([item.id, "mode"]).set("choices");
		model.api.val([item.id, "choice"]).set(item.options[0]!.id);
		let patch = model.api.flush();
		if (!patch) throw new Error("answer produced no patch");
		let edited = Store.edit(plan.questions, record.id, [...patch.toBinary()]);
		if (!edited.open || !edited.accepted) throw new Error("could not save answer");
		let claimed = Store.claimSubmit(plan.questions, record.id, edited.revision, item.header);
		if (!claimed.ok) throw new Error("could not settle question");
		Store.commit(plan.questions, claimed.claim);
	}
}

test("a batched ask creates independently addressed decision records and nodes", async () => {
	let plan = await opened();
	let definition = Questions.identify({
		questions: [
			{
				header: "Storage",
				question: "Where should room state live?",
				multiple: false,
				options: [{ label: "MDX on disk", description: "Readable." }],
			},
			{
				header: "Scope",
				question: "What belongs in the first cut?",
				multiple: true,
				options: [{ label: "Anchors", description: "Link prose." }],
			},
		],
	});

	let server = { publish() {} } as unknown as Server<SocketData>;
	let asked = asking(plan, server, definition);
	await asked.created;
	let records = [...plan.records.values()];

	expect(records).toHaveLength(2);
	expect(records.map(record => record.definition.questions)).toEqual([
		[definition.questions[0]],
		[definition.questions[1]],
	]);
	expect(room.project(plan.document).match(/<Questionnaire/g)).toHaveLength(2);

	for (let record of records.toReversed()) {
		let item = record.definition.questions[0]!;
		let opened = Store.snapshot(plan.questions, record.id);
		if (!opened.open) throw new Error("question was not open");
		let model = Question.crdt.Model.fromBinary(new Uint8Array(opened.model))
			.fork() as unknown as Question.Model;
		model.api.val([item.id, "mode"]).set("choices");
		if (item.multiple) model.api.val([item.id, "options", item.options[0]!.id]).set(true);
		else model.api.val([item.id, "choice"]).set(item.options[0]!.id);
		let patch = model.api.flush();
		if (!patch) throw new Error("answer produced no patch");
		let edited = Store.edit(plan.questions, record.id, [...patch.toBinary()]);
		if (!edited.open || !edited.accepted) throw new Error("could not save answer");
		let claimed = Store.claimSubmit(plan.questions, record.id, edited.revision, item.header);
		if (!claimed.ok) throw new Error("could not settle question");
		Store.commit(plan.questions, claimed.claim);
	}

	expect(await asked.waiting).toEqual([
		{
			status: "answered",
			resolver: "Storage",
			answers: [{ question: "Where should room state live?", choices: ["MDX on disk"] }],
		},
		{
			status: "answered",
			resolver: "Scope",
			answers: [{ question: "What belongs in the first cut?", choices: ["Anchors"] }],
		},
	]);
});

test("a pending question is inserted beside its validated prose before it is answered", async () => {
	let plan = await opened("Related prose.\n");
	let questions = definition();
	let digest = room.digests(plan.document)[0]!;
	let server = { publish() {} } as unknown as Server<SocketData>;
	let asked = asking(plan, server, questions, {
		revision: plan.revision,
		blocks: [[{ index: 0, digest }]],
	});
	await asked.created;

	let anchors = Questions.anchors(plan)[0]!.questions[questions.questions[0]!.id]!;
	let source = room.project(plan.document);
	expect(source.indexOf("Related prose.")).toBeLessThan(source.indexOf("<Questionnaire"));
	expect(anchors.anchors).toHaveLength(1);
	expect(anchors.pending).toBe(false);

	await answer(plan);
	await asked.waiting;
});

test("questions placed after one block retain their ask order", async () => {
	let plan = await opened("Related prose.\n");
	let questions = definition(2);
	let digest = room.digests(plan.document)[0]!;
	let server = { publish() {} } as unknown as Server<SocketData>;
	let asked = asking(plan, server, questions, {
		revision: plan.revision,
		blocks: [[{ index: 0, digest }], [{ index: 0, digest }]],
	});
	await asked.created;

	let source = room.project(plan.document);
	expect(source.indexOf("Related prose.")).toBeLessThan(source.indexOf("Decision 1"));
	expect(source.indexOf("Decision 1")).toBeLessThan(source.indexOf("Decision 2"));

	await answer(plan);
	await asked.waiting;
});

test("a stale placement does not create records or questionnaire nodes", async () => {
	let plan = await opened("Related prose.\n");
	let questions = definition();
	let digest = room.digests(plan.document)[0]!;
	let server = { publish() {} } as unknown as Server<SocketData>;
	let waiting = Questions.ask(plan, server, "test", questions, {
		revision: plan.revision + 1,
		blocks: [[{ index: 0, digest }]],
	});

	await expect(waiting).rejects.toThrow(/changed.*read/i);
	expect(plan.records.size).toBe(0);
	expect(room.project(plan.document)).not.toContain("<Questionnaire");
});

test("a mismatched placement digest does not create records or questionnaire nodes", async () => {
	let plan = await opened("Related prose.\n");
	let questions = definition();
	let server = { publish() {} } as unknown as Server<SocketData>;
	let waiting = Questions.ask(plan, server, "test", questions, {
		revision: plan.revision,
		blocks: [[{ index: 0, digest: room.digest("different") }]],
	});

	await expect(waiting).rejects.toThrow(/changed.*read/i);
	expect(plan.records.size).toBe(0);
	expect(room.project(plan.document)).not.toContain("<Questionnaire");
});

test("an unplaced question is rejected when prose exists without creating state", async () => {
	let plan = await opened("Related prose.\n");
	let questions = definition();
	let server = { publish() {} } as unknown as Server<SocketData>;
	let waiting = Questions.ask(plan, server, "test", questions, {
		revision: plan.revision,
		blocks: [[]],
	});

	await expect(waiting).rejects.toThrow(/relate.*write/i);
	expect(plan.records.size).toBe(0);
	expect(room.project(plan.document)).not.toContain("<Questionnaire");
});

test("unplaced questions remain valid before any prose exists", async () => {
	let plan = await opened();
	let server = { publish() {} } as unknown as Server<SocketData>;
	let first = asking(plan, server, definition(), {
		revision: plan.revision,
		blocks: [[]],
	});
	await first.created;
	let second = asking(plan, server, definition(), {
		revision: plan.revision,
		blocks: [[]],
	});
	await second.created;

	expect(plan.records.size).toBe(2);
	expect(room.project(plan.document).match(/<Questionnaire/g)).toHaveLength(2);

	await answer(plan);
	await Promise.all([first.waiting, second.waiting]);
});

test("an active implementation leaves an open questionnaire in the plan when cancellation is refused", async () => {
	let plan = await opened();
	let server = { publish() {} } as unknown as Server<SocketData>;
	let asked = asking(plan, server, definition());
	await asked.created;
	let id = [...plan.records.keys()][0]!;
	let replies: Array<{ kind: string; message?: string; rid?: string; ts?: number }> = [];
	let ws = {
		data: { handle: "ana", client: "client-ana", room: "test" },
		send(raw: string) {
			replies.push(JSON.parse(raw));
		},
	} as unknown as Socket;
	plan.execution = { id: "run-1" } as never;

	await Questions.cancel(plan, server, "test", ws, {
		kind: "question:cancel",
		ts: 0,
		rid: "cancel",
		id,
	});

	expect(replies).toEqual([{
		kind: "session:error",
		message: "implementation is active",
		ts: expect.any(Number),
		rid: "cancel",
	}]);
	expect(plan.records.get(id)?.status).toBe("open");
	expect(room.project(plan.document)).toContain("<Questionnaire");
	plan.execution = undefined;
	await Questions.cancel(plan, server, "test", ws, {
		kind: "question:cancel",
		ts: 0,
		rid: "cleanup",
		id,
	});
	await asked.waiting;
});
