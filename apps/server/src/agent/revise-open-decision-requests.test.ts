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

for (
	let [name, text] of [
		["curly-apostrophe negation", "@chopin Don’t add an option to the Authentication decision."],
		[
			"deliberative question",
			"@chopin Would it be useful to add an option to the Authentication decision?",
		],
		[
			"later withdrawal",
			"@chopin, please add an option to the Authentication decision — actually, don't.",
		],
	] as const
) {
	test(`${name} cannot change any card state`, async () => {
		let context = await opened();
		let beforeSource = room.project(context.plan.document);
		let beforeRecord = structuredClone(context.plan.records.get(context.id)!);
		let beforeRevision = context.plan.revision;
		let beforeDraftRevision = Store.get(context.plan.questions, context.id)!.revision;
		let beforeOutbox = [...context.plan.pendingCardActions];
		let beforeBroadcasts = context.broadcasts.length;
		context.request({ text });
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
		expect(room.project(context.plan.document)).toBe(beforeSource);
		expect(context.plan.records.get(context.id)).toEqual(beforeRecord);
		expect(context.plan.revision).toBe(beforeRevision);
		expect(Store.get(context.plan.questions, context.id)!.revision).toBe(beforeDraftRevision);
		expect(context.plan.pendingCardActions).toEqual(beforeOutbox);
		expect(context.broadcasts).toHaveLength(beforeBroadcasts);
	});
}

for (
	let [name, text, title, refusal] of [
		[
			"a note about options",
			"@chopin please add a note to the Authentication decision about options",
			undefined,
			"did not request new options",
		],
		[
			"a rationale edit with a distant question noun",
			"@chopin please edit the rationale for the Authentication decision question",
			"Which auth system should ship first?",
			"did not request a question edit",
		],
	] as const
) {
	test(`${name} cannot change any card state`, async () => {
		let context = await opened();
		let beforeSource = room.project(context.plan.document);
		let beforeRecord = structuredClone(context.plan.records.get(context.id)!);
		let beforeRevision = context.plan.revision;
		let beforeDraftRevision = Store.get(context.plan.questions, context.id)!.revision;
		let beforeOutbox = [...context.plan.pendingCardActions];
		let beforeBroadcasts = context.broadcasts.length;
		context.request({ text });
		let errors = spyOn(console, "error").mockImplementation(() => {});
		try {
			expect(
				await context.call({
					revision: context.plan.revision,
					id: context.id,
					...(title ? { title } : {
						add_options: [{ label: "GitHub Apps", rationale: "Repository permissions." }],
					}),
				}),
			).toContain(refusal);
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
}

for (
	let text of [
		"@chopin, please add an option called GitHub Apps to the Authentication decision.",
		"@chopin Can you add an option called GitHub Apps to the Authentication decision?",
	]
) {
	test(`affirmative direct request authorizes an option: ${text}`, async () => {
		let context = await opened();
		context.request({ text });
		let answer = JSON.parse(
			await context.call({
				revision: context.plan.revision,
				id: context.id,
				add_options: [{ label: "GitHub Apps", rationale: "Repository permissions." }],
			}),
		);
		expect(answer.ok).toBe(true);
		expect(context.plan.records.get(context.id)!.definition.questions[0]!.options)
			.toHaveLength(1);
	});
}
