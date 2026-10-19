import { expect, test } from "bun:test";

import * as Service from "../plan/service";
import { decided, reopen } from "./card-reopen.test-fixtures";
import { member } from "./text-response.test-fixtures";
import { normalizeRecord } from "./records";
import { draftedWhy, MAX_WHY, personWhy } from "./why";
import * as Questions from "./service";

function ask(id: string, text: string, rid = "w") {
	return { kind: "question:why", ts: 0, rid, id, text } as const;
}

test("a person's why is one trimmed line of at most 300 characters, and empty clears it", () => {
	expect(personWhy("  It keeps one source of truth.  ")).toEqual({
		ok: true,
		text: "It keeps one source of truth.",
	});
	expect(personWhy("   ")).toEqual({ ok: true, text: "" });
	expect(personWhy("a".repeat(MAX_WHY))).toMatchObject({ ok: true });
	expect(personWhy("a".repeat(MAX_WHY + 1))).toMatchObject({ ok: false });
	expect(personWhy("one\ntwo")).toMatchObject({ ok: false });
	expect(personWhy(7)).toMatchObject({ ok: false });
});

test("Chopin's draft must be exactly one plain sentence", () => {
	expect(draftedWhy("It keeps the answer next to the document it governs.")).toMatchObject({
		ok: true,
	});
	expect(draftedWhy("No terminal stop is fine")).toMatchObject({ ok: true });
	for (
		let bad of [
			"",
			"   ",
			"First reason. Second reason.",
			"It is **bold**.",
			"See `code` here.",
			"<b>x</b>",
			"- a list item",
			"[link](https://x.y)",
			"two\nlines",
			"a".repeat(MAX_WHY + 1),
		]
	) expect(draftedWhy(bad).ok).toBe(false);
});

test("a record keeps a bounded plain why, and whyBy needs one", () => {
	let base = {
		id: "w",
		definition: {
			questions: [{
				id: "q",
				header: "H",
				question: "Q?",
				multiple: false,
				options: [{ id: "o", label: "A", description: "" }],
			}],
		},
		status: "answered",
		origin: "human",
		owner: "ana",
		decidedAt: 1,
		choices: ["o"],
	};
	expect(normalizeRecord({ ...base, why: "Because.", whyBy: "ana" })).toMatchObject({
		why: "Because.",
		whyBy: "ana",
	});
	// A person who cleared it leaves whyBy with no why.
	expect(normalizeRecord({ ...base, whyBy: "ana" }).why).toBeUndefined();
	for (
		let bad of [
			{ why: "" },
			{ why: " padded " },
			{ why: "two\nlines" },
			{ why: "a".repeat(MAX_WHY + 1) },
			{ why: "Because.", whyBy: "" },
		]
	) expect(() => normalizeRecord({ ...base, ...bad })).toThrow(/invalid/);
});

test("an edit persists before it is announced and acknowledged, and records who wrote it", async () => {
	let context = await decided();
	let { ws, frames } = member("sam");
	await Questions.setWhy(
		context.plan,
		context.server,
		"test",
		ws,
		ask(context.id, " Fewer moving parts. "),
	);
	expect(frames.at(-1)).toMatchObject({
		kind: "question:why",
		ok: true,
		why: "Fewer moving parts.",
	});
	expect(context.plan.records.get(context.id)).toMatchObject({
		why: "Fewer moving parts.",
		whyBy: "sam",
	});
	let meta = context.broadcasts.findLast(frame => frame.kind === "question:meta") as {
		meta: { why?: string; whyBy?: string };
	};
	expect(meta.meta).toMatchObject({ why: "Fewer moving parts.", whyBy: "sam" });

	await Service.close(context.plan);
	let reopened = await Service.open(context.channel.id, context.backend, context.server);
	try {
		expect(reopened.records.get(context.id)).toMatchObject({
			why: "Fewer moving parts.",
			whyBy: "sam",
		});
	} finally {
		await Service.close(reopened);
		context.plan = reopened;
	}
});

test("an empty edit clears the why, and only a settled decision has one", async () => {
	let context = await decided();
	let { ws, frames } = member("sam");
	await Questions.setWhy(context.plan, context.server, "test", ws, ask(context.id, "Because."));
	await Questions.setWhy(context.plan, context.server, "test", ws, ask(context.id, "  "));
	expect(frames.at(-1)).toMatchObject({ kind: "question:why", id: context.id, ok: true });
	expect(frames.at(-1)).not.toHaveProperty("why");
	let record = context.plan.records.get(context.id)!;
	expect(record.why).toBeUndefined();
	// The clearing is remembered, so a draft for this settle cannot refill it.
	expect(record.whyBy).toBe("sam");

	await Questions.setWhy(context.plan, context.server, "test", ws, ask("missing", "x"));
	expect(frames.at(-1)).toMatchObject({ ok: false, message: "Decision not found" });
	await Questions.setWhy(context.plan, context.server, "test", ws, ask(context.id, "a\nb"));
	expect(frames.at(-1)).toMatchObject({ ok: false });
	context.plan.records.set(context.id, { ...record, status: "reopened" });
	await Questions.setWhy(context.plan, context.server, "test", ws, ask(context.id, "Because."));
	expect(frames.at(-1)).toMatchObject({ ok: false, message: "Only a settled decision has a why" });
});

test("a failed commit rolls the why back and announces nothing", async () => {
	let context = await decided();
	let { ws, frames } = member("sam");
	let original = context.storage.collaboration.commit;
	let before = context.broadcasts.length;
	(context.storage.collaboration as { commit: typeof original }).commit = async () => {
		throw new Error("storage unavailable");
	};
	try {
		await Questions.setWhy(context.plan, context.server, "test", ws, ask(context.id, "Because."));
	} finally {
		(context.storage.collaboration as { commit: typeof original }).commit = original;
	}
	expect(frames.at(-1)).toMatchObject({ ok: false, message: "storage unavailable" });
	expect(context.plan.records.get(context.id)!.why).toBeUndefined();
	expect(context.broadcasts).toHaveLength(before);
});

test("reopening moves the why into the answer's history and starts the next one empty", async () => {
	let context = await decided();
	await Questions.setWhy(
		context.plan,
		context.server,
		"test",
		member("sam").ws,
		ask(context.id, "Because."),
	);
	await reopen(context);
	let record = context.plan.records.get(context.id)!;
	expect(record.status).toBe("reopened");
	expect(record.why).toBeUndefined();
	expect(record.whyBy).toBeUndefined();
	expect(record.history[0]).toMatchObject({ owner: "ana", why: "Because." });
	let meta = context.broadcasts.findLast(frame => frame.kind === "question:meta") as {
		meta: { why?: string };
	};
	expect(meta.meta.why).toBeUndefined();
});
