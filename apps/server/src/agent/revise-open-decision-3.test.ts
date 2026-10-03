import { expect, spyOn, test } from "bun:test";
import * as room from "../plan/room";
import * as Store from "../questions/store";
import { createReviseOpenDecisionFixture } from "./revise-open-decision.test-fixtures";

let contexts: ReturnType<typeof createReviseOpenDecisionFixture>["contexts"];
let fixture = createReviseOpenDecisionFixture(() => contexts, value => {
	contexts = value;
});
contexts = fixture.contexts;
let { opened } = fixture;

test("editing an option rationale does not authorize a question retitle", async () => {
	let context = await opened();
	let beforeSource = room.project(context.plan.document);
	let beforeRecord = structuredClone(context.plan.records.get(context.id)!);
	let beforeRevision = context.plan.revision;
	let beforeDraftRevision = Store.get(context.plan.questions, context.id)!.revision;
	let beforeOutbox = [...context.plan.pendingCardActions];
	let beforeBroadcasts = context.broadcasts.length;
	context.request({
		text: "@chopin, please add an option to the Authentication question and edit the rationale.",
	});
	let errors = spyOn(console, "error").mockImplementation(() => {});
	try {
		expect(
			await context.call({
				revision: context.plan.revision,
				id: context.id,
				title: "Which auth system should ship first?",
			}),
		).toContain("did not request a question edit");
	} finally {
		errors.mockRestore();
	}
	expect(room.project(context.plan.document)).toBe(beforeSource);
	expect(context.plan.records.get(context.id)).toEqual(beforeRecord);
	expect(context.plan.revision).toBe(beforeRevision);
	expect(Store.get(context.plan.questions, context.id)!.revision).toBe(beforeDraftRevision);
	expect(context.plan.pendingCardActions).toEqual(beforeOutbox);
	expect(context.broadcasts).toHaveLength(beforeBroadcasts);
});

test("generic question words and ambiguous references do not identify a card", async () => {
	let context = await opened();
	let before = room.project(context.plan.document);
	let errors = spyOn(console, "error").mockImplementation(() => {});
	try {
		for (
			let [text, refusal] of [
				["@chopin What options should we add?", "did not request new options"],
				["@chopin Add an option to this decision.", "must identify this decision"],
			] as const
		) {
			context.request({ text });
			expect(
				await context.call({
					revision: context.plan.revision,
					id: context.id,
					add_options: [{ label: "GitHub Apps", rationale: "Repository permissions." }],
				}),
			).toContain(refusal);
		}
	} finally {
		errors.mockRestore();
	}
	expect(room.project(context.plan.document)).toBe(before);
	expect(context.plan.records.get(context.id)!.definition.questions[0]!.options).toEqual([]);
});

test("a named card in a deliberative question still does not authorize an edit", async () => {
	let context = await opened();
	context.request({ text: "@chopin What options should we add to the Authentication decision?" });
	let errors = spyOn(console, "error").mockImplementation(() => {});
	try {
		expect(
			await context.call({
				revision: context.plan.revision,
				id: context.id,
				add_options: [{ label: "GitHub Apps", rationale: "Repository permissions." }],
			}),
		).toContain("did not request new options");
	} finally {
		errors.mockRestore();
	}
	expect(context.plan.records.get(context.id)!.definition.questions[0]!.options).toEqual([]);
});
