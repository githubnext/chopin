import { expect, test } from "bun:test";
import { createRefineToolFixture } from "./refine-tool.test-fixtures";

let contexts: ReturnType<typeof createRefineToolFixture>["contexts"];
let fixture = createRefineToolFixture(() => contexts, value => {
	contexts = value;
});
contexts = fixture.contexts;
let { OPTION, opened, job, call } = fixture;

test("refine_decision keeps library alternatives atomic and skips reworded repeats", async () => {
	let context = await opened([{ id: OPTION, label: "Tiptap" }]);
	job(context.plan, context.id);
	let answer = JSON.parse(
		await call(context, {
			revision: context.plan.revision,
			id: context.id,
			add_options: [
				{ label: "Use Tiptap for string highlighting", rationale: "The team discussed it." },
				{ label: "ProseMirror", rationale: "It is a distinct editor approach." },
				{ label: "Lexical", rationale: "It is another editor approach." },
				{ label: "Tiptap or ProseMirror or Lexical", rationale: "The team mentioned all three." },
				{
					label: "Browser-native Selection and Range APIs",
					rationale: "The native platform approach is available.",
				},
				{ label: "Selection/Range APIs", rationale: "Restates the native approach." },
			],
		}),
	);
	expect(answer.added).toHaveLength(3);
	expect(answer.skipped).toEqual([
		"Use Tiptap for string highlighting",
		"Tiptap or ProseMirror or Lexical",
		"Selection/Range APIs",
	]);
	expect(
		context.plan.records.get(context.id)?.definition.questions[0]?.options.map(option =>
			option.label
		),
	).toEqual(["Tiptap", "ProseMirror", "Lexical", "Browser-native Selection and Range APIs"]);
});

test("refine_decision rejects a bundled sibling choice without losing distinct options", async () => {
	let context = await opened([{ id: OPTION, label: "SQLite" }]);
	job(context.plan, context.id);
	let answer = JSON.parse(
		await call(context, {
			revision: context.plan.revision,
			id: context.id,
			add_options: [
				{ label: "PostgreSQL", rationale: "The existing deployment uses it." },
				{ label: "Use PostgreSQL for storage", rationale: "Restates PostgreSQL." },
				{ label: "SQLite, PostgreSQL, and MySQL", rationale: "A grouped list." },
				{ label: "MySQL", rationale: "It is another database approach." },
			],
		}),
	);
	expect(answer.added).toHaveLength(2);
	expect(answer.skipped).toEqual(["Use PostgreSQL for storage", "SQLite, PostgreSQL, and MySQL"]);
	expect(
		context.plan.records.get(context.id)?.definition.questions[0]?.options.map(option =>
			option.label
		),
	).toEqual(["SQLite", "PostgreSQL", "MySQL"]);
});

test("refine_decision skips slash lists on an empty card but keeps a paired API approach", async () => {
	let context = await opened();
	job(context.plan, context.id);
	let answer = JSON.parse(
		await call(context, {
			revision: context.plan.revision,
			id: context.id,
			add_options: [
				{ label: "Tiptap / ProseMirror / Lexical", rationale: "A bundled library list." },
				{ label: "SQLite/PostgreSQL/MySQL", rationale: "A bundled database list." },
				{ label: "Tiptap / ProseMirror", rationale: "Two separate libraries." },
				{ label: "ProseMirror API / Lexical API", rationale: "Two separate API options." },
				{ label: "Selection/Range APIs", rationale: "One browser-native approach." },
			],
		}),
	);
	expect(answer.added).toHaveLength(1);
	expect(answer.skipped).toEqual([
		"Tiptap / ProseMirror / Lexical",
		"SQLite/PostgreSQL/MySQL",
		"Tiptap / ProseMirror",
		"ProseMirror API / Lexical API",
	]);
	expect(
		context.plan.records.get(context.id)?.definition.questions[0]?.options.map(option =>
			option.label
		),
	).toEqual(["Selection/Range APIs"]);
});
