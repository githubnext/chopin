import { expect, spyOn, test } from "bun:test";
import * as room from "../plan/room";
import * as Service from "../plan/service";
import * as Questions from "../questions/service";
import * as Store from "../questions/store";
import { publishQuestions } from "../questions/service-publish";
import { createReviseOpenDecisionFixture } from "./revise-open-decision.test-fixtures";

let contexts: ReturnType<typeof createReviseOpenDecisionFixture>["contexts"];
let fixture = createReviseOpenDecisionFixture(() => contexts, value => {
	contexts = value;
});
contexts = fixture.contexts;
let { opened } = fixture;

test("a trailing instruction appends proposed actions to the only editable choice card", async () => {
	let context = await opened([], {
		header: "Follow-up action",
		question: "What should users do after seeing a resurfaced note?",
	});
	await publishQuestions(
		context.plan,
		context.server,
		"test",
		Questions.identify({
			questions: [{
				header: "Layout direction",
				question: "Which layout should we explore next?",
				response: "text",
				multiple: false,
				options: [],
			}],
		}),
		{},
	);
	context.request({
		text: "@chopin Idan and nate, what do you both think the main actions users should take is "
			+ "after seeing a resurfaced note? I'm thinking: revise the note, archive or delete it, "
			+ "combine it with an existing note. Other ideas?\n\nadd these options to the decision",
	});
	let labels = [
		"Revise the note",
		"Archive the note",
		"Delete the note",
		"Combine with an existing note",
	];
	let result = JSON.parse(
		await context.call({
			revision: context.plan.revision,
			id: context.id,
			add_options: labels.map(label => ({
				label,
				rationale: "Proposed by Maggie in this message.",
			})),
		}),
	);
	expect(result.ok).toBe(true);
	expect(result.added).toHaveLength(4);
	let record = context.plan.records.get(context.id)!;
	expect(record.definition.questions[0]!.options.map(option => option.label)).toEqual(labels);
	expect(record.status).toBe("open");
	expect(record.choices).toBeUndefined();
	expect(Store.get(context.plan.questions, context.id)?.definition).toEqual(record.definition);
	let source = room.project(context.plan.document);
	for (let label of labels) expect(source).toContain(`label="${label}"`);
	let stored = (await context.storage.collaboration.load(context.channel.id, context.now))!;
	expect((await Service.readStored(stored)).source).toBe(source);
});

test("an unnamed option request refuses multiple editable choice cards", async () => {
	let context = await opened();
	await Questions.insertConversationCard(context.plan, context.server, "test", {
		threadId: "thread-b",
		header: "Billing",
		question: "Which billing provider should we use?",
		options: [],
	});
	context.request({ text: "Here are the proposals.\n\nAdd these options to the decision." });
	let before = room.project(context.plan.document);
	let errors = spyOn(console, "error").mockImplementation(() => {});
	try {
		expect(
			await context.call({
				revision: context.plan.revision,
				id: context.id,
				add_options: [{ label: "GitHub Apps", rationale: "Repository permissions." }],
			}),
		).toContain("must identify this decision");
	} finally {
		errors.mockRestore();
	}
	expect(room.project(context.plan.document)).toBe(before);
});

test.each([
	"If we decide to proceed later:\nAdd these options to the decision.",
	"The instruction I am considering is:\nAdd these options to the decision.",
	"Example:\nAdd these options to the decision.",
	"Add these options to the decision. But wait until Idan responds.",
	"If Idan agrees:\nAdd options to Authentication.\nAdd options to Authentication.",
	"The following is an example:\nAdd options to Authentication.\nAdd options to Authentication.",
	"The following is an example: Add options to Authentication.\n\nAdd options to Authentication.",
	"If Idan agrees: Add options to Authentication.\n\nAdd options to Authentication.",
	"Add these options to the decision. Only if Idan agrees.",
])("an illustrative directive cannot mutate the sole choice card: %s", async text => {
	let context = await opened();
	context.request({ text });
	let before = room.project(context.plan.document);
	let revision = context.plan.revision;
	let broadcasts = context.broadcasts.length;
	let stored = await context.storage.collaboration.load(context.channel.id, context.now);
	let errors = spyOn(console, "error").mockImplementation(() => {});
	try {
		expect(
			await context.call({
				revision,
				id: context.id,
				add_options: [{ label: "GitHub Apps", rationale: "Repository permissions." }],
			}),
		).toContain("did not request new options");
	} finally {
		errors.mockRestore();
	}
	expect(context.plan.revision).toBe(revision);
	expect(room.project(context.plan.document)).toBe(before);
	expect(context.plan.records.get(context.id)!.definition.questions[0]!.options).toEqual([]);
	expect(context.broadcasts).toHaveLength(broadcasts);
	expect(await context.storage.collaboration.load(context.channel.id, context.now)).toEqual(stored);
});

test.each(["closed", "claimed", "unprojected"] as const)(
	"an unrelated %s card cannot make the editable option target ambiguous",
	async state => {
		let context = await opened();
		let other = await Questions.insertConversationCard(context.plan, context.server, "test", {
			threadId: "thread-b",
			header: "Billing",
			question: "Which billing provider should we use?",
			options: [],
		});
		if (state === "closed") {
			await Questions.withdraw(context.plan, context.server, "test", other, "ana");
		} else if (state === "claimed") {
			Store.reserveEdit(context.plan.questions, other);
		} else {
			room.removeQuestionnaire(context.plan.document, other);
		}
		context.request({ text: "Add these options to the decision." });
		try {
			let result = JSON.parse(
				await context.call({
					revision: context.plan.revision,
					id: context.id,
					add_options: [{ label: "GitHub Apps", rationale: "Repository permissions." }],
				}),
			);
			expect(result.ok).toBe(true);
			expect(context.plan.records.get(context.id)!.definition.questions[0]!.options)
				.toMatchObject([{ label: "GitHub Apps" }]);
		} finally {
			if (state === "claimed") Store.releaseEdit(context.plan.questions, other);
		}
	},
);
