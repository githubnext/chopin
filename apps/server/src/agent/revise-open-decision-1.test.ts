import { expect, spyOn, test } from "bun:test";
import * as room from "../plan/room";
import * as Service from "../plan/service";
import * as Questions from "../questions/service";
import * as Store from "../questions/store";
import { createReviseOpenDecisionFixture } from "./revise-open-decision.test-fixtures";

let contexts: ReturnType<typeof createReviseOpenDecisionFixture>["contexts"];
let fixture = createReviseOpenDecisionFixture(() => contexts, value => {
	contexts = value;
});
contexts = fixture.contexts;
let { opened } = fixture;

test("separate direct calls retitle and add sourced options without deciding", async () => {
	let context = await opened();
	let beforeHistory = context.plan.records.get(context.id)!.history;
	let beforeRevision = context.plan.revision;
	let beforeBroadcasts = context.broadcasts.length;
	let retitled = JSON.parse(
		await context.call({
			revision: context.plan.revision,
			id: context.id,
			title: "Which auth system should ship first?",
		}),
	);
	expect(retitled).toMatchObject({
		ok: true,
		title: "Which auth system should ship first?",
		added: [],
	});
	let answer = JSON.parse(
		await context.call({
			revision: context.plan.revision,
			id: context.id,
			add_options: [{ label: "GitHub Apps", rationale: "Uses repository-scoped permissions." }],
		}),
	);
	expect(answer).toMatchObject({
		ok: true,
		title: "Which auth system should ship first?",
	});
	expect(answer.added).toHaveLength(1);
	let record = context.plan.records.get(context.id)!;
	expect(record.definition.questions[0]?.question).toBe(answer.title);
	expect(record.optionOrigins[answer.added[0]]).toEqual({
		origin: "planner",
		rationale: "Uses repository-scoped permissions.",
	});
	expect(record.status).toBe("open");
	expect(record.resolver).toBeUndefined();
	expect(record.choices).toBeUndefined();
	expect(record.history).toEqual(beforeHistory);
	expect(Store.get(context.plan.questions, context.id)?.definition).toEqual(record.definition);
	expect(room.project(context.plan.document)).toContain(`prompt="${answer.title}"`);
	expect(room.project(context.plan.document)).toContain('label="GitHub Apps"');
	expect(context.plan.pendingCardActions).toMatchObject([{
		kind: "option-added",
		origin: "planner",
		optionId: answer.added[0],
	}]);
	let stored = (await context.storage.collaboration.load(context.channel.id, context.now))!;
	expect((await Service.readStored(stored)).source).toBe(room.project(context.plan.document));
	expect(context.plan.chat.jobOutput).toBeUndefined();
	expect(context.plan.revision).toBe(beforeRevision + 2);
	expect(context.broadcasts.slice(beforeBroadcasts).filter(frame => frame.kind === "plan:update"))
		.toHaveLength(2);
	expect(
		context.broadcasts.slice(beforeBroadcasts).filter(frame => frame.kind === "question:changed"),
	)
		.toHaveLength(2);
});

test("a failed combined commit leaves no partial title, option, revision, or broadcast", async () => {
	let context = await opened();
	let beforeSource = room.project(context.plan.document);
	let beforeRevision = context.plan.revision;
	let beforeDraftRevision = Store.get(context.plan.questions, context.id)!.revision;
	let beforeBroadcasts = context.broadcasts.length;
	let original = context.storage.collaboration.commit;
	let commits = 0;
	(context.storage.collaboration as { commit: typeof original }).commit = async () => {
		commits++;
		throw new Error("storage unavailable");
	};
	try {
		await expect(Questions.revisePlannerCard(context.plan, context.server, "test", context.id, {
			title: "Which auth system should ship first?",
			addOptions: [{ label: "GitHub Apps", rationale: "Repository-scoped permissions." }],
		})).rejects.toThrow("storage unavailable");
	} finally {
		(context.storage.collaboration as { commit: typeof original }).commit = original;
	}
	expect(commits).toBe(1);
	expect(context.plan.revision).toBe(beforeRevision);
	expect(Store.get(context.plan.questions, context.id)!.revision).toBe(beforeDraftRevision);
	expect(room.project(context.plan.document)).toBe(beforeSource);
	expect(context.plan.records.get(context.id)!.definition.questions[0]!.options).toEqual([]);
	expect(context.plan.records.get(context.id)!.definition.questions[0]!.question).toBe(
		"What auth system should we use?",
	);
	expect(context.broadcasts).toHaveLength(beforeBroadcasts);
	expect(context.plan.pendingCardActions).toEqual([]);
});

test("two-card requests cannot carry an action across card targets", async () => {
	let context = await opened();
	let billing = await Questions.insertConversationCard(context.plan, context.server, "test", {
		threadId: "thread-b",
		header: "Billing",
		question: "Which billing provider should we use?",
		options: [],
	});
	context.request({
		text: "@chopin revise the question for Billing and add an option to Authentication",
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
		expect(
			await context.call({
				revision: beforeRevision,
				id: context.id,
				title: "Which auth system should ship first?",
				add_options: [{ label: "GitHub Apps", rationale: "Repository permissions." }],
			}),
		).toContain("one action per call");
		expect(
			await context.call({
				revision: beforeRevision,
				id: context.id,
				title: "Which auth system should ship first?",
				add_options: [],
			}),
		).toContain("one action per call");
		expect(
			await context.call({
				revision: beforeRevision,
				id: context.id,
				title: "Which auth system should ship first?",
			}),
		).toContain("must identify this decision in that action");
		expect(
			await context.call({
				revision: beforeRevision,
				id: billing,
				add_options: [{ label: "Stripe", rationale: "Known billing APIs." }],
			}),
		).toContain("must identify this decision in that action");
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
