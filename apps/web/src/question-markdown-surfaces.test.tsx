import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QuestionnaireCard } from "@chopin/editor";

import { QuestionMarkdownProvider } from "./question-markdown";

import type { Questionnaire } from "@chopin/dialect";
import type { Question } from "@chopin/protocol";

const DOCUMENT = "6f6f1c2e-0000-4000-8000-000000000001";

const PROMPT = [
	"Confirm the earlier answers",
	"",
	"(1) Storage stays in PostgreSQL",
	"(2) The pilot starts with one team",
	"",
	"- **Before:** one shared queue",
	"- **After:** a queue per team",
].join("\n");

const OPEN: Questionnaire = {
	id: "w",
	questions: [{
		id: "q",
		header: "Confirm",
		prompt: PROMPT,
		multiple: false,
		options: [
			{ id: "a", label: "Confirm all", description: "Keeps:\n(1) storage\n(2) pilot" },
			{ id: "b", label: "Change some" },
		],
	}],
};

const META: Question.CardMeta = {
	id: "w",
	status: "open",
	history: [],
	involved: [],
} as unknown as Question.CardMeta;

/** Every Markdown region of a card, in order, as its markup. */
function regions(markup: string): string[] {
	return [...markup.matchAll(/<div class="[^"]*" data-question-markdown="">[\s\S]*?<\/div>/g)].map(
		match => match[0],
	);
}

function render(presentation: "inline" | "list" | "deck", value = OPEN): string {
	return renderToStaticMarkup(
		<QuestionMarkdownProvider document={DOCUMENT}>
			<QuestionnaireCard
				canEdit
				connected
				meta={META}
				presentation={presentation}
				value={value}
			/>
		</QuestionMarkdownProvider>,
	);
}

test("one card reads the same in the Decisions tab and inline in the document", () => {
	let list = regions(render("list"));
	let inline = regions(render("inline"));
	let deck = regions(render("deck"));
	expect(list).toHaveLength(2);
	expect(inline).toEqual(list);
	expect(deck).toEqual(list);
	// Each numbered line keeps its own line, and the bullets are a list, on every surface.
	expect(list[0]).toContain(
		"(1) Storage stays in PostgreSQL<br/>\n(2) The pilot starts with one team",
	);
	expect(list[0]).toContain("<ul>\n<li><strong>Before:</strong> one shared queue</li>");
	expect(list[1]).toContain("Keeps:<br/>\n(1) storage<br/>\n(2) pilot");
});

test("an answered card keeps the same body as the open one", () => {
	let answered: Questionnaire = {
		...OPEN,
		status: "decided",
		by: "ana",
		at: "2026-10-19T10:00:00.000Z",
		questions: [{ ...OPEN.questions[0]!, answer: "Confirm all", choices: ["a"] }],
	};
	let markup = render("list", answered);
	expect(regions(markup)[0]).toEqual(regions(render("list"))[0]);
});
