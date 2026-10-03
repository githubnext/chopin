import { expect, spyOn, test } from "bun:test";
import * as room from "../plan/room";
import type { Chat } from "@chopin/protocol";
import { createRefineToolFixture } from "./refine-tool.test-fixtures";

let contexts: ReturnType<typeof createRefineToolFixture>["contexts"];
let fixture = createRefineToolFixture(() => contexts, value => {
	contexts = value;
});
contexts = fixture.contexts;
let { opened, job, call, source, d01Messages } = fixture;

test("refine_decision leaves ambiguous or non-member option evidence unattributed", async () => {
	for (let evidence of ["ambiguous", "foreign"] as const) {
		let context = await opened();
		let { m2 } = d01Messages(context);
		if (evidence === "ambiguous") {
			context.plan.chat.entries.push({ ...m2, id: "d01-m2-copy", ts: m2.ts + 1 });
		} else {
			m2.author = { kind: "agent" };
		}
		job(context.plan, context.id);
		let answer = JSON.parse(
			await call(context, {
				revision: context.plan.revision,
				id: context.id,
				add_options: [
					{ label: "Tiptap", rationale: "A possible editor approach." },
					{ label: "bare ProseMirror", rationale: "A possible editor approach." },
				],
			}),
		);
		let record = context.plan.records.get(context.id)!;
		expect(answer.added).toHaveLength(2);
		for (let id of answer.added) {
			expect(record.optionOrigins[id]?.source).toBeUndefined();
		}
	}
});

test("refine_decision rejects mismatched, foreign, and missing chat sources before edits", async () => {
	let context = await opened();
	let entry: Chat.Entry = {
		id: "message-a",
		author: { kind: "member", handle: "jev" },
		text: "We could use Lexical for selection.",
		ts: 1,
	};
	context.plan.chat.entries.push(entry);
	job(context.plan, context.id);
	let good = source(entry, "Lexical");
	let before = room.project(context.plan.document);
	let errors = spyOn(console, "error").mockImplementation(() => {});
	try {
		for (
			let citation of [
				{ ...good, quote: "TipTaps" },
				{ ...good, author: { kind: "member", handle: "other" } },
				{ ...good, messageId: "other-room-message" },
			]
		) {
			let answer = await call(context, {
				revision: context.plan.revision,
				id: context.id,
				title: "Which editor should we use?",
				add_options: [{ label: "Lexical", rationale: "Jev proposed it.", source: citation }],
			});
			expect(answer).toContain("source");
			expect(room.project(context.plan.document)).toBe(before);
			expect(context.plan.records.get(context.id)?.definition.questions[0]?.options).toEqual([]);
		}
	} finally {
		errors.mockRestore();
	}
});

test("malformed question-source bounds reject before title, placement, or option edits", async () => {
	let context = await opened();
	let { ref } = d01Messages(context);
	job(context.plan, context.id);
	let digest = room.digests(context.plan.document)[0]!;
	let beforeDocument = room.project(context.plan.document);
	let beforeRecord = structuredClone(context.plan.records.get(context.id)!);
	let beforeRevision = context.plan.revision;
	let beforeSequence = context.plan.document.seq;
	let errors = spyOn(console, "error").mockImplementation(() => {});
	try {
		let answer = await call(context, {
			revision: context.plan.revision,
			id: context.id,
			title: "Which rich-text editor should we use?",
			add_options: [{
				label: "Tiptap",
				rationale: "Rob listed this library in m2.",
				source: { ...ref, end: ref.end + 1 },
			}],
			place_after: { index: 0, digest },
		});

		expect(answer).toBe("Error: source-shape");
		expect(answer).not.toContain("invalid conversation source");
		expect(room.project(context.plan.document)).toBe(beforeDocument);
		expect(context.plan.records.get(context.id)).toEqual(beforeRecord);
		expect(context.plan.revision).toBe(beforeRevision);
		expect(context.plan.document.seq).toBe(beforeSequence);
	} finally {
		errors.mockRestore();
	}
});
