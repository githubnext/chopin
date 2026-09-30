import { expect, test } from "bun:test";
import * as Question from "@chopin/question";

import * as Questions from "./questions/service";
import * as Store from "./questions/store";
import * as room from "./plan/room";

import { openPlan } from "./testing/plan";
import type { Server } from "bun";
import type { Plan } from "./plan/service";
import type { SocketData } from "./wire";
import { createQuestionServiceFixture } from "./question-service.test-fixtures";

let plans: Plan[];
let fixture = createQuestionServiceFixture(() => plans, value => {
	plans = value;
});
plans = fixture.plans;
let { opened, definition, asking } = fixture;

// Whole archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2 callbacks and data; import/fixture wrappers only.
test("present malformed card provenance is refused on restore", async () => {
	let base = {
		id: "w1",
		definition: definition(),
		status: "answered",
		origin: "planner",
		history: [],
		optionOrigins: {},
		editors: [],
	};
	let invalid: Array<[string, object]> = [
		["unknown status", { status: "maybe" }],
		["origin", { origin: "unknown" }],
		["null origin", { origin: null }],
		["history", { history: null }],
		["history entry", { history: [{ choices: [], owner: "ana" }] }],
		["option origins", { optionOrigins: [] }],
		["option origin entry", {
			optionOrigins: {
				[base.definition.questions[0]!.options[0]!.id]: {
					origin: "unknown",
				},
			},
		}],
		["option origin rationale", {
			optionOrigins: {
				[base.definition.questions[0]!.options[0]!.id]: {
					origin: "planner",
					rationale: [],
				},
			},
		}],
		["editors", { editors: ["ana", null] }],
	];
	for (let [, fields] of invalid) {
		await expect(openPlan("", { questions: [{ ...base, ...fields }] })).rejects.toThrow(
			"invalid question record",
		);
	}
});

test("a card record restores its chosen IDs and provenance", async () => {
	let value = definition();
	let option = value.questions[0]!.options[0]!.id;
	let threadId = "t".repeat(200);
	let { plan } = await openPlan("", {
		questions: [{
			id: "w1",
			definition: value,
			status: "answered",
			origin: "conversation",
			threadId,
			owner: "ben",
			decidedAt: 2,
			choices: [option],
			history: [{ choices: [option], owner: "ana", at: 1 }],
			optionOrigins: { [option]: { origin: "human", by: "ana" } },
			editors: ["ana", "ben"],
		}],
	});
	plans.push(plan);
	expect(plan.records.get("w1")).toMatchObject({
		origin: "conversation",
		threadId,
		owner: "ben",
		decidedAt: 2,
		choices: [option],
		history: [{ choices: [option], owner: "ana", at: 1 }],
		optionOrigins: { [option]: { origin: "human", by: "ana" } },
		editors: ["ana", "ben"],
	});
});

test("stored card choices and metadata reject unknown, duplicate or malformed values", async () => {
	let value = definition();
	let option = value.questions[0]!.options[0]!.id;
	let base = {
		id: "w1",
		definition: value,
		status: "answered",
		origin: "planner",
		history: [],
		optionOrigins: {},
		editors: [],
	};
	let invalid: Array<[string, object]> = [
		["malformed definition cardinality", {
			definition: {
				questions: [{ ...value.questions[0]!, multiple: "no" }],
			},
		}],
		["unknown chosen option", { choices: ["missing"] }],
		["duplicate or excessive chosen options", { choices: [option, option] }],
		["malformed choices", { choices: null }],
		["unknown historical option", { history: [{ choices: ["missing"], owner: "ana", at: 1 }] }],
		["duplicate historical choices", {
			history: [{ choices: [option, option], owner: "ana", at: 1 }],
		}],
		["unknown option origin", { optionOrigins: { missing: { origin: "chat" } } }],
		["duplicate editors", { editors: ["ana", "ana"] }],
		["milliseconds, not Unix seconds", { decidedAt: 1_790_334_980_000 }],
		["nonfinite history timestamp", { history: [{ choices: [], owner: "ana", at: Infinity }] }],
		["invalid owner", { owner: null }],
		["invalid thread", { threadId: [] }],
		["thread too long for a card", { threadId: "x".repeat(201) }],
		["invalid prose anchor", { prose: [{ epoch: "e", position: "p", digest: "bad" }] }],
		["malformed prose position", {
			prose: [{ epoch: "e", position: "p", digest: `sha256:${"0".repeat(64)}` }],
		}],
	];
	for (let [, fields] of invalid) {
		await expect(openPlan("", { questions: [{ ...base, ...fields }] })).rejects.toThrow(
			"invalid question record",
		);
	}
});

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
	expect(records.map(record => ({
		origin: record.origin,
		history: record.history,
		optionOrigins: record.optionOrigins,
		editors: record.editors,
	}))).toEqual([
		{ origin: "planner", history: [], optionOrigins: {}, editors: [] },
		{ origin: "planner", history: [], optionOrigins: {}, editors: [] },
	]);
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
