import { expect, spyOn, test } from "bun:test";
import { plannerConfiguration } from "./scoped-tools.test-configuration";
import * as room from "../plan/room";
import { createReviseOpenDecisionFixture } from "./revise-open-decision.test-fixtures";

let contexts: ReturnType<typeof createReviseOpenDecisionFixture>["contexts"];
let fixture = createReviseOpenDecisionFixture(() => contexts, value => {
	contexts = value;
});
contexts = fixture.contexts;
let { opened } = fixture;

test("the direct card tool is present in the hosted model's custom tools", async () => {
	let context = await opened([{ id: "01K0N4W3B7P27CBAEC7A8C8WEA", label: "Anchors" }]);
	let config = plannerConfiguration({ model: "model" }, { tools: context.tools }, {
		token: "ghu_owner",
		repository: { id: "R_repo", owner: "octo-org", name: "score", defaultBranch: "main" },
	});
	expect(config.availableTools).toContain("custom:*");
	expect(config.tools?.map(tool => tool.name)).toContain("revise_open_decision");
	expect(config.tools?.find(tool => tool.name === "revise_open_decision")?.skipPermission)
		.toBe(false);
	let read = context.tools.find(tool => tool.name === "read_plan")!;
	let snapshot = JSON.parse(String(await read.handler!({}, {} as never)));
	expect(snapshot.questions.find((item: { id: string }) => item.id === context.id).options)
		.toEqual([["Anchors"]]);
});

test("direct card edit requires a current member request and is fenced from jobs", async () => {
	let context = await opened();
	let errors = spyOn(console, "error").mockImplementation(() => {});
	try {
		context.request();
		expect(await context.call({ revision: context.plan.revision, id: context.id, title: "Why?" }))
			.toContain("current member request");
		context.request({ text: "@chopin revise the Authentication decision question" });
		context.plan.chat.job = {
			id: `refine:${context.id}:m1`,
			kind: "refine",
			target: context.id,
			trigger: "m1",
			status: "running",
			attempts: 0,
			at: "2026-09-25T10:00:00.000Z",
		};
		expect(await context.call({ revision: context.plan.revision, id: context.id, title: "Why?" }))
			.toContain("current member request");
	} finally {
		errors.mockRestore();
	}
	expect(context.plan.records.get(context.id)?.definition.questions[0]?.question).toBe(
		"What auth system should we use?",
	);
});

test("stale revisions, closed cards, duplicate labels and option limits refuse before mutation", async () => {
	let context = await opened([{ id: "01K0N4W3B7P27CBAEC7A8C8WEA", label: "Anchors" }]);
	let before = room.project(context.plan.document);
	let errors = spyOn(console, "error").mockImplementation(() => {});
	try {
		let base = { revision: context.plan.revision, id: context.id };
		expect(await context.call({ ...base, revision: base.revision + 1, title: "Why now?" }))
			.toContain("read_plan again");
		expect(
			await context.call({
				...base,
				add_options: [{ label: " anchors ", rationale: "Duplicate" }],
			}),
		)
			.toContain("duplicate option");
		expect(
			await context.call({
				...base,
				add_options: Array.from({ length: 10 }, (_, i) => ({
					label: `Option ${i}`,
					rationale: "Evidence",
				})),
			}),
		).toContain("too many options");
		context.plan.records.delete(context.id);
		expect(await context.call({ ...base, title: "Why now?" })).toContain("no longer open");
	} finally {
		errors.mockRestore();
	}
	expect(room.project(context.plan.document)).toBe(before);
});
