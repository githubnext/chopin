import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
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

async function opened(): Promise<Plan> {
	let directory = await mkdtemp(join(tmpdir(), "chopin-question-service-"));
	directories.push(directory);
	let server = { publish() {} } as unknown as Server<SocketData>;
	let plan = await Service.open("test", directory, server);
	plans.push(plan);
	return plan;
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
