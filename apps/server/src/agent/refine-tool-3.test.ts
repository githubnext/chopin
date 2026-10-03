import { expect, test } from "bun:test";
import * as Service from "../plan/service";
import { effectsFor } from "../conversation-plan/effects";
import type { ConversationPlan } from "@chopin/protocol";
import { createRefineToolFixture } from "./refine-tool.test-fixtures";

let contexts: ReturnType<typeof createRefineToolFixture>["contexts"];
let fixture = createRefineToolFixture(() => contexts, value => {
	contexts = value;
});
contexts = fixture.contexts;
let { opened, job, call, d01Messages } = fixture;

test("refine_decision sources unique D01 options from the saved member list", async () => {
	let context = await opened();
	let { m2 } = d01Messages(context);
	let candidates = [
		{ label: "Tiptap", quote: "Tiptap", start: 0, end: 6 },
		{ label: "bare ProseMirror", quote: "bare ProseMirror", start: 8, end: 24 },
		{ label: "Lexical", quote: "Lexical", start: 26, end: 33 },
		{
			label: "just native Selection and Range with our own document model",
			quote: "just native Selection and Range with our own document model",
			start: 38,
			end: 97,
		},
	] as const;
	job(context.plan, context.id);
	let add_options = candidates.map(({ label }) => ({
		label,
		rationale: "Rob listed this editor approach in m2.",
	}));
	let response = await call(context, {
		revision: context.plan.revision,
		id: context.id,
		add_options,
	});
	expect(response).not.toContain("Error:");
	let answer = JSON.parse(response);
	let ids: string[] = answer.added;
	let expectedSources: ConversationPlan.SourceRef[] = candidates.map(candidate => ({
		messageId: m2.id,
		author: m2.author as ConversationPlan.SourceAuthor,
		quote: candidate.quote,
		start: candidate.start,
		end: candidate.end,
		role: "option" as const,
	}));
	expect(ids).toHaveLength(candidates.length);
	let optionEvents = context.plan.conversationPlan.events.filter(event =>
		event.type === "option.added" && ids.includes(event.contribution.id)
	);
	expect(optionEvents.map(event => event.type === "option.added" && event.contribution.id))
		.toEqual(ids);
	expect(optionEvents.map(event => event.type === "option.added" ? event.source : undefined))
		.toEqual(expectedSources);

	let retry = JSON.parse(
		await call(context, {
			revision: context.plan.revision,
			id: context.id,
			add_options,
		}),
	);
	expect(retry.added).toEqual([]);
	expect(
		context.plan.records.get(context.id)?.definition.questions[0]?.options.map(option => option.id),
	).toEqual(ids);
	optionEvents = context.plan.conversationPlan.events.filter(event =>
		event.type === "option.added" && ids.includes(event.contribution.id)
	);
	expect(optionEvents.map(event => event.type === "option.added" && event.contribution.id))
		.toEqual(ids);

	await Service.close(context.plan);
	contexts = [];
	let restored = await Service.open(context.channel.id, context.backend, context.server);
	contexts.push({ ...context, plan: restored });
	let restoredRecord = restored.records.get(context.id)!;
	expect(restoredRecord.definition.questions[0]?.options.map(option => option.id)).toEqual(ids);
	let restoredOptionEvents = restored.conversationPlan.events.filter(event =>
		event.type === "option.added" && ids.includes(event.contribution.id)
	);
	expect(
		restoredOptionEvents.map(event =>
			event.type === "option.added" ? event.contribution.id : undefined
		),
	).toEqual(ids);
	expect(
		restoredOptionEvents.map(event => event.type === "option.added" ? event.source : undefined),
	).toEqual(expectedSources);
	expect(
		effectsFor(restoredOptionEvents, restored.conversationPlan, undefined, restored.records),
	).toEqual([]);
	expect(ids.map(id => restoredRecord.optionOrigins[id]?.source)).toEqual(expectedSources);
});

test("refine_decision matches the D01 native option without its leading chat filler", async () => {
	let context = await opened();
	let { m2 } = d01Messages(context);
	job(context.plan, context.id);
	let answer = JSON.parse(
		await call(context, {
			revision: context.plan.revision,
			id: context.id,
			add_options: [{
				label: "Native Selection and Range with our own document model",
				rationale: "Rob named this browser-native editor approach in m2.",
			}],
		}),
	);
	let expected: ConversationPlan.SourceRef = {
		messageId: m2.id,
		author: m2.author as ConversationPlan.SourceAuthor,
		quote: "just native Selection and Range with our own document model",
		start: 38,
		end: 97,
		role: "option",
	};
	expect(answer.added).toHaveLength(1);
	let optionId = answer.added[0] as string;
	let optionEvent = context.plan.conversationPlan.events.find(event =>
		event.type === "option.added" && event.contribution.id === optionId
	);
	expect(optionEvent?.type === "option.added" ? optionEvent.source : undefined).toEqual(expected);
	expect(context.plan.records.get(context.id)?.optionOrigins[optionId]?.source).toEqual(expected);
});

test("refine_decision keeps Just Eat, unrelated, bundled, and ambiguous evidence distinct", async () => {
	let context = await opened();
	let { m2 } = d01Messages(context);
	context.plan.chat.entries.push({
		id: "just-eat",
		author: { kind: "member", handle: "Rob" },
		text: "Just Eat",
		ts: 3,
	});
	context.plan.chat.entries.push({ ...m2, id: "d01-m2-copy", ts: m2.ts + 1 });
	job(context.plan, context.id);
	let answer = JSON.parse(
		await call(context, {
			revision: context.plan.revision,
			id: context.id,
			add_options: [
				{ label: "Eat", rationale: "A distinct product name." },
				{ label: "Trix", rationale: "An unrelated product." },
				{ label: "Tiptap or Lexical", rationale: "Two bundled editor choices." },
				{
					label: "Native Selection and Range with our own document model",
					rationale: "The duplicate evidence is ambiguous.",
				},
			],
		}),
	);
	let record = context.plan.records.get(context.id)!;
	expect(answer.added).toHaveLength(3);
	expect(answer.skipped).toEqual(["Tiptap or Lexical"]);
	for (let id of answer.added as string[]) {
		expect(record.optionOrigins[id]?.source).toBeUndefined();
	}
});
