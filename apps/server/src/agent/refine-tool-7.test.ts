import { expect, spyOn, test } from "bun:test";
import * as room from "../plan/room";
import { createRefineToolFixture } from "./refine-tool.test-fixtures";

let contexts: ReturnType<typeof createRefineToolFixture>["contexts"];
let fixture = createRefineToolFixture(() => contexts, value => {
	contexts = value;
});
contexts = fixture.contexts;
let { OPTION, opened, job, call } = fixture;

test("refine_decision preserves a distinct extended product name", async () => {
	let context = await opened([{ id: OPTION, label: "React" }]);
	job(context.plan, context.id);
	let answer = JSON.parse(
		await call(context, {
			revision: context.plan.revision,
			id: context.id,
			add_options: [
				{ label: "React Native", rationale: "A mobile framework is a separate approach." },
				{ label: "Use React for the browser", rationale: "Restates the existing option." },
			],
		}),
	);
	expect(answer.added).toHaveLength(1);
	expect(answer.skipped).toEqual(["Use React for the browser"]);
	expect(
		context.plan.records.get(context.id)?.definition.questions[0]?.options.map(option =>
			option.label
		),
	).toEqual(["React", "React Native"]);
});

test("refine_decision refuses another target, stale revision, and closed records", async () => {
	let context = await opened();
	let errors = spyOn(console, "error").mockImplementation(() => {});
	try {
		job(context.plan, context.id);
		let before = room.project(context.plan.document);
		expect(await call(context, { revision: context.plan.revision, id: OPTION }))
			.toContain("different decision");
		expect(await call(context, { revision: context.plan.revision + 1, id: context.id }))
			.toContain("read_plan again");
		context.plan.records.delete(context.id);
		expect(await call(context, { revision: context.plan.revision, id: context.id }))
			.toContain("no longer open");
		expect(room.project(context.plan.document)).toBe(before);
		expect(context.plan.chat.jobOutput).toBeUndefined();
	} finally {
		errors.mockRestore();
	}
});

test("a queued refine tool cannot write after its background job is replaced", async () => {
	let context = await opened();
	job(context.plan, context.id);
	let entered = Promise.withResolvers<void>();
	let release = Promise.withResolvers<void>();
	let delayed = call(context, {
		revision: context.plan.revision,
		id: context.id,
		title: "Why now?",
	}, (_plan, action) => {
		entered.resolve();
		return release.promise.then(action);
	});
	await entered.promise;
	context.plan.chat.job = { ...context.plan.chat.job!, id: `refine:${context.id}:m2` };
	release.resolve();
	let errors = spyOn(console, "error").mockImplementation(() => {});
	try {
		expect(await delayed).toContain("background Planner job changed");
	} finally {
		errors.mockRestore();
	}
	expect(context.plan.records.get(context.id)?.definition.questions[0]?.question).toBe(
		"What auth system should we use?",
	);
	expect(context.plan.chat.jobOutput).toBeUndefined();
});
