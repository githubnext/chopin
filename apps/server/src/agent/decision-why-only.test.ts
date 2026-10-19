import { expect, test } from "bun:test";

import { createDecisionProseFixture } from "./decision-prose.test-fixtures";
import { member } from "../questions/text-response.test-fixtures";
import * as Questions from "../questions/service";

let contexts: ReturnType<typeof createDecisionProseFixture>["contexts"];
let fixture = createDecisionProseFixture(() => contexts, value => {
	contexts = value;
});
contexts = fixture.contexts;
let { CARD, opened, proseTool } = fixture;

const WHY = "It keeps one source of truth for every device.";

async function humanDecision() {
	let context = await opened();
	let { threadId: _threadId, ...record } = context.plan.records.get(CARD)!;
	context.plan.records.set(CARD, { ...record, origin: "human" });
	return context;
}

function whyJob(context: Awaited<ReturnType<typeof opened>>, generation = 1) {
	context.plan.chat.job = {
		id: `prose:${CARD}:why:${CARD}:${generation}`,
		kind: "prose",
		target: CARD,
		trigger: `why:${CARD}:${generation}`,
		status: "running",
		attempts: 0,
		at: "2026-09-25T10:00:00.000Z",
	};
}

const args = (context: Awaited<ReturnType<typeof opened>>, extra: object = { why: WHY }) => ({
	revision: context.plan.revision,
	id: CARD,
	...extra,
});

test("a why-only job saves the draft and announces it without touching the document", async () => {
	let context = await humanDecision();
	whyJob(context);
	let revision = context.plan.revision;
	let result = await proseTool(context).handler(args(context), {} as never);
	expect(JSON.parse(String(result)).ok).toBe(true);
	let record = context.plan.records.get(CARD)!;
	expect(record.why).toBe(WHY);
	expect(record.whyBy).toBeUndefined();
	expect(context.plan.revision).toBe(revision);
	let meta = context.broadcasts.findLast(frame => frame.kind === "question:meta") as {
		meta: { why?: string; whyBy?: string };
	};
	expect(meta.meta.why).toBe(WHY);
	expect(meta.meta.whyBy).toBeUndefined();
});

test("a person's why beats a why-only draft", async () => {
	let context = await humanDecision();
	context.plan.records.set(CARD, {
		...context.plan.records.get(CARD)!,
		why: "We trust the vendor.",
		whyBy: "mina",
	});
	whyJob(context);
	await proseTool(context).handler(args(context), {} as never);
	expect(context.plan.records.get(CARD)).toMatchObject({
		why: "We trust the vendor.",
		whyBy: "mina",
	});
});

test("a person who cleared the why is not refilled by a draft for the same settle", async () => {
	let context = await humanDecision();
	let { ws } = member("sam");
	await Questions.setWhy(context.plan, context.server, "test", ws, {
		kind: "question:why",
		ts: 0,
		rid: "a",
		id: CARD,
		text: "Our reason.",
	});
	await Questions.setWhy(context.plan, context.server, "test", ws, {
		kind: "question:why",
		ts: 0,
		rid: "b",
		id: CARD,
		text: "",
	});
	expect(context.plan.records.get(CARD)).toMatchObject({ whyBy: "sam" });
	expect(context.plan.records.get(CARD)!.why).toBeUndefined();
	whyJob(context);
	await proseTool(context).handler(args(context), {} as never);
	expect(context.plan.records.get(CARD)!.why).toBeUndefined();

	// The conversation write-up's draft is held back the same way.
	let paragraph = await opened();
	paragraph.plan.records.set(CARD, { ...paragraph.plan.records.get(CARD)!, whyBy: "sam" });
	paragraph.plan.chat.job = {
		id: `prose:${CARD}:decided:${CARD}:1`,
		kind: "prose",
		target: CARD,
		trigger: `decided:${CARD}:1`,
		status: "running",
		attempts: 0,
		at: "2026-09-25T10:00:00.000Z",
	};
	await proseTool(paragraph).handler(
		{ ...args(paragraph), text: "We chose GitHub Apps." },
		{} as never,
	);
	expect(paragraph.plan.records.get(CARD)!.why).toBeUndefined();
	expect(paragraph.plan.records.get(CARD)!.whyBy).toBe("sam");
});

test("clearing a draft marks the person, while clearing an empty why changes nothing", async () => {
	let context = await humanDecision();
	let { ws } = member("sam");
	let ask = (text: string, rid: string) =>
		({
			kind: "question:why",
			ts: 0,
			rid,
			id: CARD,
			text,
		}) as const;
	await Questions.setWhy(context.plan, context.server, "test", ws, ask("", "a"));
	expect(context.plan.records.get(CARD)!.whyBy).toBeUndefined();
	context.plan.records.set(CARD, { ...context.plan.records.get(CARD)!, why: "A draft." });
	await Questions.setWhy(context.plan, context.server, "test", ws, ask("", "b"));
	expect(context.plan.records.get(CARD)).toMatchObject({ whyBy: "sam" });
	expect(context.plan.records.get(CARD)!.why).toBeUndefined();
});

test("a why-only job refuses a stale generation, a paragraph, or a conversation decision", async () => {
	let context = await humanDecision();
	whyJob(context, 2);
	expect(String(await proseTool(context).handler(args(context), {} as never))).toStartWith(
		"Error:",
	);
	whyJob(context);
	let withText = await proseTool(context).handler(
		args(context, { why: WHY, text: "A paragraph." }),
		{} as never,
	);
	expect(String(withText)).toStartWith("Error:");
	expect(context.plan.records.get(CARD)!.why).toBeUndefined();

	let conversation = await opened();
	whyJob(conversation);
	expect(String(await proseTool(conversation).handler(args(conversation), {} as never)))
		.toStartWith("Error:");
	expect(conversation.plan.records.get(CARD)!.why).toBeUndefined();
});
