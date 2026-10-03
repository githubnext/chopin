import { test } from "bun:test";
import { createRefineToolFixture } from "./refine-tool.test-fixtures";

let contexts: ReturnType<typeof createRefineToolFixture>["contexts"];
let fixture = createRefineToolFixture(() => contexts, value => {
	contexts = value;
});
contexts = fixture.contexts;
let { expectExplicitSourceNotAuthoritative } = fixture;

test("refine_decision rejects an explicit unrelated member quote as an option source", async () => {
	await expectExplicitSourceNotAuthoritative({
		id: "unrelated-option-source",
		author: { kind: "member", handle: "jev" },
		text: "We should use server-side caching for this endpoint.",
		ts: 1,
	}, "server-side caching");
});

test("refine_decision rejects an explicit agent-authored option source", async () => {
	await expectExplicitSourceNotAuthoritative({
		id: "agent-option-source",
		author: { kind: "agent" },
		text: "Tiptap is a good fit for the editor.",
		ts: 1,
	}, "Tiptap");
});

test("refine_decision rejects an explicit quote that bundles same-approach choices", async () => {
	await expectExplicitSourceNotAuthoritative({
		id: "paired-option-source",
		author: { kind: "member", handle: "jev" },
		text: "Tiptap or Lexical would work for the editor.",
		ts: 1,
	}, "Tiptap or Lexical");
});
