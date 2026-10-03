import { expect, test } from "bun:test";

import * as Question from "@chopin/question";

import * as Questions from "./questions/service";
import * as Store from "./questions/store";
import * as room from "./plan/room";
import * as Service from "./plan/service";

import type { Server } from "bun";
import type { Plan } from "./plan/service";
import type { Socket, SocketData } from "./wire";

import { createQuestionServiceFixture } from "./question-service.test-fixtures";
let plans: Plan[];
let fixture = createQuestionServiceFixture(() => plans, value => {
	plans = value;
});
plans = fixture.plans;
let { opened, definition, asking, answer } = fixture;

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
			answers: [{
				question: "Where should room state live?",
				choices: ["MDX on disk"],
				optionIds: [records[0]!.definition.questions[0]!.options[0]!.id],
			}],
		},
		{
			status: "answered",
			resolver: "Scope",
			answers: [{
				question: "What belongs in the first cut?",
				choices: ["Anchors"],
				optionIds: [records[1]!.definition.questions[0]!.options[0]!.id],
			}],
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

test("an active implementation refuses to create a questionnaire", async () => {
	let plan = await opened();
	let server = { publish() {} } as unknown as Server<SocketData>;
	let revision = plan.revision;
	plan.execution = { id: "run-1" } as never;

	await expect(Questions.ask(plan, server, "test", definition()))
		.rejects.toThrow("implementation is active");

	expect(plan.revision).toBe(revision);
	expect(plan.records.size).toBe(0);
	expect(room.project(plan.document)).not.toContain("<Questionnaire");
});

function member(handle = "ana") {
	let sent: Array<Record<string, unknown>> = [];
	let ws = {
		data: { handle, client: `client-${handle}`, room: "test" },
		send(raw: string) {
			sent.push(JSON.parse(raw));
		},
	} as unknown as Socket;
	return { ws, sent };
}

function adding(
	plan: Plan,
	server: Server<SocketData>,
	ws: Socket,
	id: string,
	label: string,
	key = "key-0000-0001",
) {
	let question = plan.records.get(id)!.definition.questions[0].id;
	return Questions.addOption(plan, server, "test", ws, {
		kind: "question:option",
		ts: 0,
		rid: `rid-${key}-${label}`,
		id,
		question,
		key,
		label,
	});
}

test("an appended option is durable in the record, draft store and plan before anyone hears of it", async () => {
	let plan = await opened();
	let published: Array<{ kind: string }> = [];
	let server = {
		publish(_topic: string, raw: string) {
			published.push(JSON.parse(raw));
		},
	} as unknown as Server<SocketData>;
	let asked = asking(plan, server, definition());
	await asked.created;
	let id = [...plan.records.keys()][0]!;
	published.length = 0;
	let { ws, sent } = member();

	await adding(plan, server, ws, id, "  A third way ");

	let reply = sent.at(-1) as { ok: boolean; option: { id: string; label: string } };
	expect(reply.ok).toBe(true);
	expect(reply.option.label).toBe("A third way");
	let item = plan.records.get(id)!.definition.questions[0];
	let options = item.options;
	expect(options.map(option => option.label)).toEqual(["Choose this", "A third way"]);
	expect(Store.get(plan.questions, id)!.definition.questions[0].options).toEqual(options);
	expect(room.project(plan.document)).toContain("A third way");
	// Committed, not merely applied in memory.
	expect(plan.persistence.lastSidecar).toContain("A third way");
	expect(published.map(frame => frame.kind)).toEqual(["plan:update", "question:option-added"]);

	// Everyone can choose it and the decision reads as the new label.
	let snapshot = Store.snapshot(plan.questions, id);
	if (!snapshot.open) throw new Error("not open");
	let model = Question.crdt.Model.fromBinary(new Uint8Array(snapshot.model))
		.fork() as unknown as Question.Model;
	model.api.val([item.id, "choice"]).set(reply.option.id);
	let edited = Store.edit(plan.questions, id, [...model.api.flush().toBinary()]);
	if (!edited.open || !edited.accepted) throw new Error("could not choose the option");
	let claimed = Store.claimSubmit(plan.questions, id, edited.revision, "ana");
	if (!claimed.ok) throw new Error("could not claim");
	expect(claimed.answers).toEqual([{
		question: item.question,
		choices: ["A third way"],
		optionIds: [reply.option.id],
	}]);
	Store.commit(plan.questions, claimed.claim);
	await asked.waiting;
});

test("repeating an option request with the same key returns the same option", async () => {
	let plan = await opened();
	let server = { publish() {} } as unknown as Server<SocketData>;
	let asked = asking(plan, server, definition());
	await asked.created;
	let id = [...plan.records.keys()][0]!;
	let { ws, sent } = member();

	await adding(plan, server, ws, id, "Once");
	let revision = plan.revision;
	await adding(plan, server, ws, id, "Once");

	let [first, second] = sent as Array<{ ok: boolean; option: { id: string }; repeated?: boolean }>;
	expect(second!.option.id).toBe(first!.option.id);
	expect(second!.repeated).toBe(true);
	expect(plan.records.get(id)!.definition.questions[0].options).toHaveLength(2);
	expect(plan.revision).toBe(revision);
});

test("an option is refused for duplicates, bounds, settled questions and active implementations", async () => {
	let plan = await opened();
	let server = { publish() {} } as unknown as Server<SocketData>;
	let asked = asking(plan, server, definition());
	await asked.created;
	let id = [...plan.records.keys()][0]!;
	let { ws, sent } = member();
	let last = () => sent.at(-1) as { ok: boolean; reason?: string };

	await adding(plan, server, ws, id, "choose THIS", "key-0000-0002");
	expect(last()).toMatchObject({ ok: false, reason: "duplicate" });
	await adding(plan, server, ws, id, "   ", "key-0000-0003");
	expect(last()).toMatchObject({ ok: false, reason: "invalid" });
	await adding(plan, server, ws, id, "ok", "no");
	expect(last()).toMatchObject({ ok: false, reason: "invalid" });
	expect(plan.records.get(id)!.definition.questions[0].options).toHaveLength(1);

	plan.execution = { id: "run-1" } as never;
	await adding(plan, server, ws, id, "Blocked", "key-0000-0004");
	expect(last()).toMatchObject({ ok: false, reason: "implementation" });
	plan.execution = undefined;

	for (let index = 0; index < Question.limits.MAX_SHARED_OPTIONS - 1; index++) {
		await adding(plan, server, ws, id, `Extra ${index}`, `key-fill-${index}0000`);
		expect(last().ok).toBe(true);
	}
	await adding(plan, server, ws, id, "Overflow", "key-0000-0005");
	expect(last()).toMatchObject({ ok: false, reason: "full" });

	let claimed = Store.claimCancel(plan.questions, id, "ana");
	if (!claimed.ok) throw new Error("could not claim");
	await adding(plan, server, ws, id, "During", "key-0000-0006");
	expect(last()).toMatchObject({ ok: false, reason: "resolving" });
	Store.commit(plan.questions, claimed.claim);
	await adding(plan, server, ws, id, "After", "key-0000-0007");
	expect(last()).toMatchObject({ ok: false, reason: "resolved" });
	await asked.waiting;
});

test("a redefined open question survives dump and restore with its older draft", async () => {
	let plan = await opened();
	let server = { publish() {} } as unknown as Server<SocketData>;
	let asked = asking(plan, server, definition());
	await asked.created;
	let id = [...plan.records.keys()][0]!;
	let { ws } = member();
	await adding(plan, server, ws, id, "Restored");

	let restored = Store.restore(JSON.parse(JSON.stringify(Store.dump(plan.questions))));
	let entry = Store.get(restored, id)!;
	expect(entry.definition.questions[0].options.map(option => option.label)).toEqual([
		"Choose this",
		"Restored",
	]);
	expect(Question.read(entry.model, entry.definition)).toBeDefined();
	Store.shutdown(restored);
	let claimed = Store.claimCancel(plan.questions, id, "ana");
	if (claimed.ok) Store.commit(plan.questions, claimed.claim);
	await asked.waiting;
});

test("concurrent appends with one key add one option; with one label add one option", async () => {
	let plan = await opened();
	let server = { publish() {} } as unknown as Server<SocketData>;
	let asked = asking(plan, server, definition());
	await asked.created;
	let id = [...plan.records.keys()][0]!;
	let ana = member("ana");
	let bo = member("bo");

	await Promise.all([
		adding(plan, server, ana.ws, id, "Same key", "key-same-0001"),
		adding(plan, server, bo.ws, id, "Same key", "key-same-0001"),
		adding(plan, server, ana.ws, id, "Same label", "key-label-0001"),
		adding(plan, server, bo.ws, id, "same LABEL", "key-label-0002"),
	]);

	let labels = plan.records.get(id)!.definition.questions[0].options.map(option => option.label);
	expect(labels).toEqual(["Choose this", "Same key", "Same label"]);
	expect(Object.keys(plan.records.get(id)!.appended!)).toHaveLength(2);
	expect((bo.sent.at(-1) as { reason?: string }).reason).toBe("duplicate");
	let claimed = Store.claimCancel(plan.questions, id, "ana");
	if (claimed.ok) Store.commit(plan.questions, claimed.claim);
	await asked.waiting;
});

test("an implementation claimed while an append waits leaves the room untouched", async () => {
	let plan = await opened();
	let server = { publish() {} } as unknown as Server<SocketData>;
	let asked = asking(plan, server, definition());
	await asked.created;
	let id = [...plan.records.keys()][0]!;
	let { ws, sent } = member();
	let before = room.project(plan.document);

	let release = Promise.withResolvers<void>();
	let held = Service.exclusive(plan, () => release.promise);
	let pending = adding(plan, server, ws, id, "Late", "key-late-0001");
	plan.claiming = true;
	release.resolve();
	await held;
	await pending;
	plan.claiming = false;

	expect(sent.at(-1)).toMatchObject({ ok: false, reason: "implementation" });
	expect(room.project(plan.document)).toBe(before);
	expect(plan.records.get(id)!.definition.questions[0].options).toHaveLength(1);
	expect(plan.records.get(id)!.appended).toBeUndefined();
	let claimed = Store.claimCancel(plan.questions, id, "ana");
	if (claimed.ok) Store.commit(plan.questions, claimed.claim);
	await asked.waiting;
});

test("a failed commit restores the record and the open definition, and nobody is told", async () => {
	let plan = await opened();
	let published: Array<{ kind: string }> = [];
	let server = {
		publish(_topic: string, raw: string) {
			published.push(JSON.parse(raw));
		},
	} as unknown as Server<SocketData>;
	let asked = asking(plan, server, definition());
	await asked.created;
	let id = [...plan.records.keys()][0]!;
	let { ws, sent } = member();
	published.length = 0;

	let original = plan.persistence.storage.collaboration.commit;
	let fatal = plan.persistence.fatal;
	plan.persistence.fatal = () => {};
	plan.persistence.storage.collaboration.commit = () => Promise.reject(new Error("disk full"));
	let quiet = console.error;
	console.error = () => {};
	try {
		await adding(plan, server, ws, id, "Lost", "key-lost-0001");
	} finally {
		console.error = quiet;
		plan.persistence.storage.collaboration.commit = original;
		plan.persistence.fatal = fatal;
	}

	expect(sent.at(-1)).toMatchObject({ kind: "session:error" });
	expect(published).toEqual([]);
	expect(plan.records.get(id)!.definition.questions[0].options).toHaveLength(1);
	expect(plan.records.get(id)!.appended).toBeUndefined();
	expect(Store.get(plan.questions, id)!.definition.questions[0].options).toHaveLength(1);
	let claimed = Store.claimCancel(plan.questions, id, "ana");
	if (claimed.ok) Store.commit(plan.questions, claimed.claim);
	await asked.waiting;
});
