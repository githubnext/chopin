import { expect, test } from "bun:test";

import { headingPrompt, refinePrompt } from "./job-prompts";

test("the heading prompt quotes recent members and names its one writing tool", () => {
	let prompt = headingPrompt({
		transcript: [
			{
				id: "m1",
				author: { kind: "member", handle: "mina" },
				text: "Okay we gotta figure out auth",
				ts: 1,
			},
			{ id: "m2", author: { kind: "system" }, text: "Sam joined", ts: 2 },
		],
		outline: "",
	});
	expect(prompt).toContain("- @mina: Okay we gotta figure out auth");
	expect(prompt).not.toContain("Sam joined");
	expect(prompt).toContain("call `draft_heading` once");
	expect(prompt).toContain("Use no other writing tool. Do not reply in chat.");
});

test("a suggest prompt forbids retitling and moving", () => {
	let prompt = refinePrompt({
		kind: "suggest",
		id: "W1",
		question: "What auth system should we use?",
		options: ["Auth0", "GitHub Apps"],
		outline: "0 heading sha256:123",
		revision: 3,
	});
	expect(prompt).toContain("1. Auth0\n2. GitHub Apps");
	expect(prompt).toContain("Do not change the title and do not move the card.");
	expect(prompt).toContain("call `refine_decision` exactly once with id W1");
});

test("a refine prompt includes bounded evidence and card option labels", () => {
	let prompt = refinePrompt({
		kind: "refine",
		id: "W1",
		question: "Where should auth live?",
		options: ["Auth0", "GitHub Apps"],
		outline: "0 heading sha256:123",
		revision: 3,
		thread: {
			contributions: [{
				kind: "reason",
				text: `Use the repository identity ${"x".repeat(2000)}`,
				sources: [{
					messageId: "m1",
					quote: "Use the repository identity",
					start: 0,
					end: 27,
					role: "reason",
					author: {
						kind: "member",
						handle: "mina",
					},
				}],
			}],
			stances: [{ participant: "sam", position: "support", optionId: "o2", sources: [] }],
		} as never,
	});
	expect(prompt).toContain("What people said:");
	expect(prompt).toContain(
		'context_source={"messageId":"m1","author":{"kind":"member","handle":"mina"},',
	);
	expect(prompt).toContain('"quote":"Use the repository identity","start":0,"end":27,');
	expect(prompt).toContain("- @sam supports o2");
	expect(prompt).toContain("Reword the title to ask which approach the team should choose");
	expect(prompt).toContain("Split mutually exclusive alternatives");
	expect(prompt).toContain("including slash lists");
	expect(prompt).toContain("Compare the underlying approaches, not just exact labels");
	expect(prompt).toContain("Do not invent a source or rationale");
	expect(prompt).toContain(
		"Only a displayed `option_source` with role `option` or a `question_source`",
	);
	expect(prompt).toContain("`context_source` from a reason, constraint, or stance");
	expect(prompt).toContain("For repository/document evidence, omit");
	expect(prompt).toContain("unclear, omit that addition");
	expect(prompt).toContain("place_after");
	expect(prompt).not.toContain("x".repeat(1000));
});

test("a refine prompt preserves exact UTF-16 source offsets and whitespace", () => {
	let span = "Tiptap  or\nProseMirror 🤖";
	let source = {
		messageId: "m-emoji",
		author: { kind: "member", handle: "fawkes" },
		quote: span,
		start: 7,
		end: 7 + span.length,
		role: "option",
	};
	let prompt = refinePrompt({
		kind: "refine",
		id: "W1",
		question: "Which approach should we use for highlighting?",
		options: [],
		outline: "",
		revision: 1,
		thread: {
			contributions: [{ kind: "option", text: span, sources: [source] }],
			stances: [],
		} as never,
	});
	let line = prompt.split("\n").find(line => line.startsWith("- option:"));
	expect(line).toBeDefined();
	expect(line).toContain("option_source=");
	let cited = JSON.parse(line!.slice(line!.indexOf("source=") + "source=".length));
	expect(cited).toEqual(source);
	expect(cited.end - cited.start).toBe(span.length);
	expect(prompt).toContain("omit `source` when neither exact source is shown");
});
