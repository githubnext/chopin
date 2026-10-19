import { expect, test } from "bun:test";
import { createDecisionProseFixture } from "./decision-prose.test-fixtures";

let contexts: ReturnType<typeof createDecisionProseFixture>["contexts"];
let fixture = createDecisionProseFixture(() => contexts, value => {
	contexts = value;
});
contexts = fixture.contexts;
let { CARD, opened, job, proseTool, input } = fixture;

const WHY = "Apps give each repository its own narrow grant.";

test("the write-up commits Chopin's why with the paragraph and marks it as a draft", async () => {
	let context = await opened();
	job(context);
	let result = await proseTool(context).handler({ ...input(context), why: WHY }, {} as never);
	expect(JSON.parse(String(result)).ok).toBe(true);
	let record = context.plan.records.get(CARD)!;
	expect(record.why).toBe(WHY);
	expect(record.whyBy).toBeUndefined();
	let meta = context.broadcasts.findLast(frame => frame.kind === "question:meta") as {
		meta: { why?: string; whyBy?: string };
	};
	expect(meta.meta.why).toBe(WHY);
	expect(meta.meta.whyBy).toBeUndefined();
});

test("a person's why always wins over a later draft, and a draft yields to a redraft", async () => {
	let context = await opened();
	context.plan.records.set(CARD, {
		...context.plan.records.get(CARD)!,
		why: "We trust the vendor.",
		whyBy: "mina",
	});
	job(context);
	let result = await proseTool(context).handler({ ...input(context), why: WHY }, {} as never);
	expect(JSON.parse(String(result)).ok).toBe(true);
	expect(context.plan.records.get(CARD)).toMatchObject({
		why: "We trust the vendor.",
		whyBy: "mina",
	});

	let other = await opened();
	other.plan.records.set(CARD, { ...other.plan.records.get(CARD)!, why: "An older draft." });
	job(other);
	await proseTool(other).handler({ ...input(other), why: WHY }, {} as never);
	expect(other.plan.records.get(CARD)!.why).toBe(WHY);
});

test("the why is optional, and an invalid one fails the call without changing the document", async () => {
	let context = await opened();
	job(context);
	let result = await proseTool(context).handler(input(context), {} as never);
	expect(JSON.parse(String(result)).ok).toBe(true);
	expect(context.plan.records.get(CARD)!.why).toBeUndefined();

	let strict = await opened();
	job(strict);
	let revision = strict.plan.revision;
	for (let bad of ["One. Two.", "**bold**", "", "a".repeat(301)]) {
		let failed = await proseTool(strict).handler({ ...input(strict), why: bad }, {} as never);
		expect(String(failed)).toStartWith("Error:");
	}
	expect(strict.plan.revision).toBe(revision);
	expect(strict.plan.records.get(CARD)!.why).toBeUndefined();
});
