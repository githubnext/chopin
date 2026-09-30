import { expect, spyOn, test } from "bun:test";
import * as room from "../plan/room";
import * as Questions from "../questions/service";
import * as Store from "../questions/store";
import { createReviseOpenDecisionFixture } from "./revise-open-decision.test-fixtures";

let contexts: ReturnType<typeof createReviseOpenDecisionFixture>["contexts"];
let fixture = createReviseOpenDecisionFixture(() => contexts, value => {
	contexts = value;
});
contexts = fixture.contexts;
let { opened } = fixture;

test("contrast and multiple card names cannot authorize the excluded card", async () => {
	let context = await opened();
	let billing = await Questions.insertConversationCard(context.plan, context.server, "test", {
		threadId: "thread-b",
		header: "Billing",
		question: "Which billing provider should we use?",
		options: [],
	});
	let beforeSource = room.project(context.plan.document);
	let beforeRecords = structuredClone([...context.plan.records]);
	let beforeDrafts = [context.id, billing].map(id =>
		Store.get(context.plan.questions, id)!.revision
	);
	let beforeRevision = context.plan.revision;
	let beforeOutbox = [...context.plan.pendingCardActions];
	let beforeBroadcasts = context.broadcasts.length;
	let errors = spyOn(console, "error").mockImplementation(() => {});
	try {
		for (
			let [text, input] of [
				[
					"@chopin add an option to Authentication instead of Billing",
					{ id: billing, add_options: [{ label: "Stripe", rationale: "Known billing APIs." }] },
				],
				[
					"@chopin revise the question for Authentication rather than Billing",
					{ id: billing, title: "Which billing system should ship first?" },
				],
				[
					"@chopin add an option to Authentication and Billing",
					{ id: billing, add_options: [{ label: "Stripe", rationale: "Known billing APIs." }] },
				],
				[
					"@chopin add an option to Authentication except Billing",
					{ id: billing, add_options: [{ label: "Stripe", rationale: "Known billing APIs." }] },
				],
			] as const
		) {
			context.request({ text });
			expect(await context.call({ revision: beforeRevision, ...input }))
				.toContain("must identify this decision in that action");
		}
	} finally {
		errors.mockRestore();
	}
	expect(room.project(context.plan.document)).toBe(beforeSource);
	expect([...context.plan.records]).toEqual(beforeRecords);
	expect([context.id, billing].map(id => Store.get(context.plan.questions, id)!.revision))
		.toEqual(beforeDrafts);
	expect(context.plan.revision).toBe(beforeRevision);
	expect(context.plan.pendingCardActions).toEqual(beforeOutbox);
	expect(context.broadcasts).toHaveLength(beforeBroadcasts);
});

test("reference or backscroll instructions cannot authorize an unrequested card edit", async () => {
	let context = await opened();
	let errors = spyOn(console, "error").mockImplementation(() => {});
	try {
		context.request({ text: "@chopin summarize the Authentication decision" });
		expect(
			await context.call({
				revision: context.plan.revision,
				id: context.id,
				title: "Why now?",
			}),
		).toContain("did not request a question edit");
		context.request({ text: "@chopin revise the Authentication decision question" });
		expect(
			await context.call({
				revision: context.plan.revision,
				id: context.id,
				add_options: [{ label: "GitHub Apps", rationale: "Repository permissions" }],
			}),
		).toContain("did not request new options");
		context.request({ text: "@chopin revise the question for Search" });
		expect(
			await context.call({
				revision: context.plan.revision,
				id: context.id,
				title: "Why now?",
			}),
		).toContain("must identify this decision");
	} finally {
		errors.mockRestore();
	}
	expect(context.plan.records.get(context.id)?.definition.questions[0]?.question).toBe(
		"What auth system should we use?",
	);
});

test("negated or withdrawn edit language never authorizes an option", async () => {
	let context = await opened();
	let before = room.project(context.plan.document);
	let errors = spyOn(console, "error").mockImplementation(() => {});
	try {
		for (
			let text of [
				"@chopin Don't add an option to the Authentication decision.",
				"@chopin Please cancel my request to add an option to the Authentication decision.",
			]
		) {
			context.request({ text });
			expect(
				await context.call({
					revision: context.plan.revision,
					id: context.id,
					add_options: [{ label: "GitHub Apps", rationale: "Repository permissions." }],
				}),
			).toContain("did not request new options");
		}
	} finally {
		errors.mockRestore();
	}
	expect(room.project(context.plan.document)).toBe(before);
	expect(context.plan.records.get(context.id)!.definition.questions[0]!.options).toEqual([]);
});
