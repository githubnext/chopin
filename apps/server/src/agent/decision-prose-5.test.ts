import { expect, spyOn, test } from "bun:test";
import * as room from "../plan/room";
import * as Service from "../plan/service";
import { createDecisionProseFixture } from "./decision-prose.test-fixtures";

let contexts: ReturnType<typeof createDecisionProseFixture>["contexts"];
let fixture = createDecisionProseFixture(() => contexts, value => {
	contexts = value;
});
contexts = fixture.contexts;
let { CARD, opened, job, proseTool, input } = fixture;

test("failed prose persistence leaves live source, record, and publication untouched", async () => {
	let context = await opened();
	job(context);
	let before = room.project(context.plan.document);
	let record = context.plan.records.get(CARD);
	let records = context.plan.records;
	let original = context.storage.collaboration.commit;
	context.storage.collaboration.commit = async () => {
		throw new Error("storage unavailable");
	};
	context.backend.fatal = () => {};
	let errors = spyOn(console, "error").mockImplementation(() => {});
	try {
		expect(String(await proseTool(context).handler(input(context), {} as never)))
			.toBe("Error: storage unavailable");
	} finally {
		errors.mockRestore();
		context.storage.collaboration.commit = original;
	}
	expect(room.project(context.plan.document)).toBe(before);
	expect(context.plan.records).toBe(records);
	expect(context.plan.records.get(CARD)).toBe(record);
	expect(context.plan.document.seq).toBe(0);
	expect(context.plan.chat.jobOutput).toBeUndefined();
	expect(context.broadcasts.filter(frame => frame.kind === "plan:update")).toHaveLength(0);
	expect(context.broadcasts.filter(frame => frame.kind === "plan:anchors")).toHaveLength(0);
});

test("a post-commit anchor relay error does not turn the durable write into a failed tool call", async () => {
	let context = await opened();
	job(context);
	context.breakRelay("plan:anchors");
	let errors = spyOn(console, "error").mockImplementation(() => {});
	try {
		let result = await proseTool(context).handler(input(context), {} as never);
		expect(JSON.parse(String(result)).ok).toBe(true);
		expect(context.plan.chat.jobOutput).toBeDefined();
		expect(room.project(context.plan.document)).toContain("We chose GitHub Apps.");
		let loaded = (await context.storage.collaboration.load(context.channel.id, context.now))!;
		expect((await Service.readStored(loaded)).source).toBe(room.project(context.plan.document));
	} finally {
		errors.mockRestore();
	}
});
