import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as Question from "@chopin/question";

import * as Questions from "./questions/service";
import * as Store from "./questions/store";
import * as room from "./plan/room";
import * as Service from "./plan/service";

import type { Server } from "bun";
import type { Plan } from "./plan/service";
import type { SocketData } from "./wire";

let directories: string[] = [];
let plans: Plan[] = [];

afterEach(async () => {
	for (let plan of plans) await Service.close(plan);
	plans = [];
	for (let directory of directories) await rm(directory, { recursive: true, force: true });
	directories = [];
});

async function opened(source = ""): Promise<Plan> {
	let directory = await mkdtemp(join(tmpdir(), "chopin-question-service-"));
	directories.push(directory);
	if (source) await writeFile(join(directory, "plan.mdx"), source);
	let server = { publish() {} } as unknown as Server<SocketData>;
	let plan = await Service.open("test", directory, server);
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
	let waiting = Questions.ask(plan, server, "test", definition);
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

	expect(await waiting).toEqual([
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
	let waiting = Questions.ask(plan, server, "test", questions, {
		revision: plan.revision,
		blocks: [[{ index: 0, digest }]],
	});

	let anchors = Questions.anchors(plan)[0]!.questions[questions.questions[0]!.id]!;
	let source = room.project(plan.document);
	expect(source.indexOf("Related prose.")).toBeLessThan(source.indexOf("<Questionnaire"));
	expect(anchors.anchors).toHaveLength(1);
	expect(anchors.pending).toBe(false);

	await answer(plan);
	await waiting;
});

test("questions placed after one block retain their ask order", async () => {
	let plan = await opened("Related prose.\n");
	let questions = definition(2);
	let digest = room.digests(plan.document)[0]!;
	let server = { publish() {} } as unknown as Server<SocketData>;
	let waiting = Questions.ask(plan, server, "test", questions, {
		revision: plan.revision,
		blocks: [[{ index: 0, digest }], [{ index: 0, digest }]],
	});

	let source = room.project(plan.document);
	expect(source.indexOf("Related prose.")).toBeLessThan(source.indexOf("Decision 1"));
	expect(source.indexOf("Decision 1")).toBeLessThan(source.indexOf("Decision 2"));

	await answer(plan);
	await waiting;
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

	expect(plan.records.size).toBe(0);
	expect(room.project(plan.document)).not.toContain("<Questionnaire");
	await expect(waiting).rejects.toThrow(/changed.*read/i);
});

test("a mismatched placement digest does not create records or questionnaire nodes", async () => {
	let plan = await opened("Related prose.\n");
	let questions = definition();
	let server = { publish() {} } as unknown as Server<SocketData>;
	let waiting = Questions.ask(plan, server, "test", questions, {
		revision: plan.revision,
		blocks: [[{ index: 0, digest: room.digest("different") }]],
	});

	expect(plan.records.size).toBe(0);
	expect(room.project(plan.document)).not.toContain("<Questionnaire");
	await expect(waiting).rejects.toThrow(/changed.*read/i);
});

test("an unplaced question is rejected when prose exists without creating state", async () => {
	let plan = await opened("Related prose.\n");
	let questions = definition();
	let server = { publish() {} } as unknown as Server<SocketData>;
	let waiting = Questions.ask(plan, server, "test", questions, {
		revision: plan.revision,
		blocks: [[]],
	});

	expect(plan.records.size).toBe(0);
	expect(room.project(plan.document)).not.toContain("<Questionnaire");
	await expect(waiting).rejects.toThrow(/relate.*write/i);
});

test("unplaced questions remain valid before any prose exists", async () => {
	let plan = await opened();
	let server = { publish() {} } as unknown as Server<SocketData>;
	let first = Questions.ask(plan, server, "test", definition(), {
		revision: plan.revision,
		blocks: [[]],
	});
	let second = Questions.ask(plan, server, "test", definition(), {
		revision: plan.revision,
		blocks: [[]],
	});
	void second.catch(() => undefined);

	expect(plan.records.size).toBe(2);
	expect(room.project(plan.document).match(/<Questionnaire/g)).toHaveLength(2);

	await answer(plan);
	await Promise.all([first, second]);
});
