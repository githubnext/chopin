import { expect, test } from "bun:test";
import { restoreState } from "./domain";
import { extractQuotes } from "./quotes";
import { d01LiveListWithClarification } from "./pipeline-clarification.test-fixtures";

test("D01 live four-option scores need one strong joint clarification for an atomic batch", async () => {
	let { output, current, state, threadId, clarifications } = await d01LiveListWithClarification({
		clarification: "strong",
	});
	let quotes = extractQuotes(current.text);
	expect(output.events.map(event => event.type)).toEqual(Array(4).fill("option.added"));
	expect(output.events.map(event => "source" in event && event.source)).toMatchObject(
		quotes.map(quote => ({ ...quote, messageId: current.id, role: "option" })),
	);
	expect(output.events.map(event => event.type === "option.added" && event.threadId))
		.toEqual(Array(4).fill(threadId));
	expect(
		new Set(output.events.map(event => event.type === "option.added" && event.contribution.id))
			.size,
	).toBe(4);
	expect(clarifications).toBe(1);
	expect(output.analysis.passes[2]).toMatchObject({
		stage: "clarification",
		version: "bare-editor-clarification-1",
	});
	state.analysis.push({
		messageId: current.id,
		eventIds: output.events.map(event => event.id),
		...output.analysis,
	});
	expect(restoreState(JSON.parse(JSON.stringify(state))).analysis[0]!.passes[2])
		.toEqual(output.analysis.passes[2]);
});

test("D01 joint clarification stays closed on weak, missing, or failed evidence", async () => {
	for (let clarification of ["weak", "missing", "failed"] as const) {
		let { output } = await d01LiveListWithClarification({ clarification });
		expect(output.events).toEqual([]);
	}
	let changed = await d01LiveListWithClarification({
		clarification: "strong",
		changedModel: true,
	});
	expect(changed.clarifications).toBe(1);
	expect(changed.output.events).toEqual([]);
});

test("D01 joint clarification rejects a linked card option before contribution mirroring", async () => {
	let { output, state, threadId, linkedCards, clarifications } = await d01LiveListWithClarification(
		{ state: "linked-card", clarification: "strong" },
	);
	expect(state.threads[0]!.contributions.filter(item => item.kind === "option"))
		.toEqual([]);
	expect(linkedCards?.get(threadId)?.options).toHaveLength(1);
	expect(output.events).toEqual([]);
	expect(clarifications).toBe(0);
});

test("D01 joint clarification cannot override source, ownership, or thread guards", async () => {
	for (
		let option of [
			{ state: "no-thread" as const },
			{ state: "existing-option" as const },
			{ state: "competing-thread" as const },
			{ owned: 0.1 },
		]
	) {
		let { output } = await d01LiveListWithClarification({
			...option,
			clarification: "strong",
		});
		expect(output.events).toEqual([]);
	}
	for (
		let text of [
			`Nia said, "Tiptap, bare ProseMirror, Lexical, or just native Selection and Range with our own document model."`,
			`"Tiptap, bare ProseMirror, Lexical, or just native Selection and Range with our own document model."`,
			"Not Tiptap, bare ProseMirror, Lexical, or just native Selection and Range with our own document model.",
			"Tiptap, bare ProseMirror, Lexical, Slate, or just native Selection and Range with our own document model.",
			"Tiptap, bare ProseMirror, Lexical, or Tiptap.",
		]
	) {
		let { output, clarifications } = await d01LiveListWithClarification({
			text,
			clarification: "strong",
		});
		expect(clarifications).toBe(0);
		expect(output.events.filter(event => event.type === "option.added").length).toBeLessThan(4);
	}
});
