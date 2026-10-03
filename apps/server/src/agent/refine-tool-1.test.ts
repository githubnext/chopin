import { expect, spyOn, test } from "bun:test";
import * as room from "../plan/room";
import * as Service from "../plan/service";
import * as Questions from "../questions/service";
import type { Chat } from "@chopin/protocol";
import { createRefineToolFixture } from "./refine-tool.test-fixtures";

let contexts: ReturnType<typeof createRefineToolFixture>["contexts"];
let fixture = createRefineToolFixture(() => contexts, value => {
	contexts = value;
});
contexts = fixture.contexts;
let { opened, job, call, source, linkQuestion } = fixture;

test("refine_decision persists one question mention for two named alternatives", async () => {
	let context = await opened();
	let entry: Chat.Entry = {
		id: "message-question",
		author: { kind: "member", handle: "jev" },
		text: "Could we use Lexical or ProseMirror?",
		ts: 1,
	};
	context.plan.chat.entries.push(entry);
	let ref = { ...source(entry, "Lexical or ProseMirror"), role: "question" as const };
	linkQuestion(context, ref);
	job(context.plan, context.id);
	let answer = JSON.parse(
		await call(context, {
			revision: context.plan.revision,
			id: context.id,
			add_options: [
				{ label: "Lexical", rationale: "Named in Jev's question.", source: ref },
				{ label: "ProseMirror", rationale: "Named in Jev's question.", source: ref },
			],
		}),
	);
	expect(answer.ok).toBe(true);
	expect(answer.added).toHaveLength(2);
	for (let id of answer.added) {
		expect(context.plan.records.get(context.id)?.optionOrigins[id]?.source).toEqual(ref);
	}
	let loaded = (await context.storage.collaboration.load(context.channel.id, context.now))!;
	await expect(Service.readStored(loaded)).resolves.toBeDefined();
	let sidecar = structuredClone(loaded.sidecar ?? loaded.snapshot!.sidecar) as {
		questions: Questions.Record[];
	};
	sidecar.questions[0]!.optionOrigins[answer.added[0]]!.source = {
		...ref,
		quote: "Lexical",
		end: ref.start + 7,
	};
	await expect(Service.readStored({ ...loaded, sidecar: sidecar as never }))
		.rejects.toThrow(/option question source outside its card thread/);
});

test("refine_decision rejects question refs outside the card thread and other roles", async () => {
	let context = await opened();
	let entry: Chat.Entry = {
		id: "message-question",
		author: { kind: "member", handle: "jev" },
		text: "Could we use Lexical or ProseMirror?",
		ts: 1,
	};
	context.plan.chat.entries.push(entry);
	let unrelated: Chat.Entry = { ...entry, id: "other-question", ts: 2 };
	context.plan.chat.entries.push(unrelated);
	let ref = { ...source(entry, "Lexical or ProseMirror"), role: "question" as const };
	linkQuestion(context, ref);
	job(context.plan, context.id);
	let before = room.project(context.plan.document);
	let errors = spyOn(console, "error").mockImplementation(() => {});
	try {
		for (
			let citation of [
				{ ...ref, quote: "Lexical", end: ref.start + 7 },
				{ ...ref, messageId: unrelated.id },
				{ ...ref, author: { kind: "member", handle: "other" } },
				{ ...ref, role: "reason" },
				{ ...ref, role: "constraint" },
			]
		) {
			let answer = await call(context, {
				revision: context.plan.revision,
				id: context.id,
				title: "Which editor should we use?",
				add_options: [{ label: "Lexical", rationale: "Named in question.", source: citation }],
			});
			expect(answer).toContain("Error");
			expect(room.project(context.plan.document)).toBe(before);
			expect(context.plan.records.get(context.id)?.definition.questions[0]?.options).toEqual([]);
		}
	} finally {
		errors.mockRestore();
	}
});

test("refine_decision persists a verified exact chat source and restores it", async () => {
	let context = await opened();
	let entry: Chat.Entry = {
		id: "message-a",
		author: { kind: "member", handle: "jev" },
		text: "We could use Lexical for selection.",
		ts: 1,
	};
	context.plan.chat.entries.push(entry);
	job(context.plan, context.id);
	let citation = source(entry, "Lexical");
	let answer = JSON.parse(
		await call(context, {
			revision: context.plan.revision,
			id: context.id,
			add_options: [{ label: "Lexical", rationale: "Jev proposed it.", source: citation }],
		}),
	);
	expect(answer.ok).toBe(true);
	let origin = context.plan.records.get(context.id)?.optionOrigins[answer.added[0]];
	expect(origin).toEqual({ origin: "planner", rationale: "Jev proposed it.", source: citation });
	let loaded = (await context.storage.collaboration.load(context.channel.id, context.now))!;
	let sidecar = loaded.sidecar ?? loaded.snapshot!.sidecar;
	expect(
		(sidecar as { questions: Questions.Record[] }).questions[0]?.optionOrigins[answer.added[0]],
	)
		.toEqual(origin!);
	await expect(Service.readStored(loaded)).resolves.toBeDefined();
	let damaged = structuredClone(sidecar) as { questions: Questions.Record[] };
	damaged.questions[0]!.optionOrigins[answer.added[0]]!.source!.quote = "TipTaps";
	await expect(Service.readStored({ ...loaded, sidecar: damaged as never }))
		.rejects.toThrow(/invalid option source/);
});
