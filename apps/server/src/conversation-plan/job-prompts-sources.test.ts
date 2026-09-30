import { expect, test } from "bun:test";

import { refinePrompt } from "./job-prompts";

test("a question mention exposes its exact source without treating it as support", () => {
	let quote = "Lexical or ProseMirror 🤖?";
	let ref = {
		messageId: "m1",
		author: { kind: "member", handle: "mina" },
		quote,
		start: 12,
		end: 12 + quote.length,
		role: "question",
	};
	let prompt = refinePrompt({
		kind: "refine",
		id: "W1",
		question: "Which editor?",
		options: [],
		outline: "",
		revision: 1,
		thread: { questionSources: [ref], contributions: [], stances: [] } as never,
	});
	let line = prompt.split("\n").find(line => line.startsWith("- question_source="));
	expect(JSON.parse(line!.slice("- question_source=".length))).toEqual(ref);
	expect(prompt).toContain("it does not\nendorse either choice");
	expect(prompt).toContain(
		"Keep a question-sourced\noption label faithful to the named alternative",
	);
	expect(prompt).toContain("do not add specificity that the\nquestion did not name");
});

test("source evidence is bounded by complete citations, never a sliced JSON span", () => {
	let sources = Array.from({ length: 20 }, (_, index) => ({
		messageId: `m${index}`,
		author: { kind: "member", handle: "fawkes" },
		quote: `Option ${index} ${"a".repeat(700)}`,
		start: 0,
		end: 708 + String(index).length,
		role: "option",
	}));
	let prompt = refinePrompt({
		kind: "refine",
		id: "W1",
		question: "Which approach?",
		options: [],
		outline: "",
		revision: 1,
		thread: {
			contributions: sources.map((source, index) => ({
				kind: "option",
				text: `Option ${index}`,
				sources: [source],
			})),
			stances: [],
		} as never,
	});
	let evidence = prompt.split("What people said:\n")[1]!.split("\n\n")[0]!;
	expect(evidence.length).toBeLessThanOrEqual(6000);
	expect(evidence).toContain('"messageId":"m19"');
	for (let line of evidence.split("\n")) {
		let cited = JSON.parse(line.slice(line.indexOf("source=") + "source=".length));
		expect(cited.quote).toBe(sources[Number(cited.messageId.slice(1))]?.quote);
	}
});

test("unsourced evidence does not acquire a fabricated citation", () => {
	let prompt = refinePrompt({
		kind: "suggest",
		id: "W1",
		question: "Which storage approach?",
		options: [],
		outline: "0 paragraph sha256:123 PostgreSQL is installed",
		revision: 1,
		thread: {
			contributions: [{ kind: "reason", text: "Repository uses PostgreSQL", sources: [] }],
			stances: [],
		} as never,
	});
	expect(prompt).toContain("- reason: Repository uses PostgreSQL");
	expect(prompt).not.toContain("source={");
	expect(prompt).toContain("For repository/document evidence, omit");
});

test("reason and constraint citations cannot be copied as option provenance", () => {
	let sources = ["reason", "constraint"].map((role, index) => ({
		messageId: `m${index}`,
		author: { kind: "member", handle: "mina" },
		quote: role === "reason" ? "Needs keyboard support" : "Avoid a new dependency",
		start: 0,
		end: role === "reason" ? 22 : 22,
		role,
	}));
	let prompt = refinePrompt({
		kind: "refine",
		id: "W1",
		question: "Which approach?",
		options: [],
		outline: "",
		revision: 1,
		thread: {
			contributions: sources.map(source => ({
				kind: source.role,
				text: source.quote,
				sources: [source],
			})),
			stances: [],
		} as never,
	});
	expect(prompt).toContain("context_source=");
	expect(prompt).not.toContain("option_source=");
	expect(prompt).toContain("Never copy a");
	expect(prompt).toContain("Those may inform");
});
