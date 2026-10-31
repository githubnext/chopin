import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QuestionnaireCard } from "@chopin/editor";

import { QuestionMarkdownProvider } from "./question-markdown";

import type { Questionnaire } from "@chopin/dialect";
import type { Question } from "@chopin/protocol";

const DOCUMENT = "6f6f1c2e-0000-4000-8000-000000000001";
const OWN = `/images/${"a".repeat(64)}.png`;
const ELSEWHERE = "https://example.test/tracker.png";

const OPEN: Questionnaire = {
	id: "w",
	questions: [{
		id: "q",
		header: "Cache",
		prompt: "How should writes reach the cache?",
		multiple: false,
		options: [
			{
				id: "a",
				label: "Write-through",
				description: "Safe.",
				preview: `![Write, cache and database in one path](${OWN})`,
			},
			{
				id: "b",
				label: "Write-back",
				preview: `![A tracker](${ELSEWHERE})\n\n| Cost | Risk |\n| --- | --- |\n| Low | Loss |`,
			},
			{ id: "c", label: "Skip the cache", description: "Simplest." },
		],
	}],
};

const META = { id: "w", status: "open", history: [], involved: [] } as unknown as Question.CardMeta;

function render(
	presentation: "inline" | "list" | "deck",
	value = OPEN,
	meta: Question.CardMeta = META,
): string {
	return renderToStaticMarkup(
		<QuestionMarkdownProvider document={DOCUMENT}>
			<QuestionnaireCard
				canEdit
				connected
				meta={meta}
				presentation={presentation}
				value={value}
			/>
		</QuestionMarkdownProvider>,
	);
}

function previews(markup: string): string[] {
	return [...markup.matchAll(/<div[^>]*data-question-preview=""[\s\S]*?<\/div><\/div>/g)].map(
		match => match[0].replace(/aria-labelledby="[^"]*"/g, ""),
	);
}

test("an option's visual shows framed under that option, and only that option's", () => {
	let markup = render("list");
	expect(previews(markup)).toHaveLength(2);
	let first = previews(markup)[0]!;
	expect(first).toContain('role="group"');
	expect(first).toContain('aria-label="Preview of Write-through"');
	// A real image, loaded for this document only, with its alt text, opening large from a button.
	expect(first).toContain(`src="${OWN}?document=${DOCUMENT}"`);
	expect(first).toContain('alt="Write, cache and database in one path"');
	expect(first).toContain('aria-label="View larger: Write, cache and database in one path"');
	// The option without one has no frame, and its row is unchanged.
	let third = markup.slice(markup.indexOf("Skip the cache"));
	expect(third).not.toContain("data-question-preview");
});

test("an image that is not this document's own shows its alt text, never a request", () => {
	let second = previews(render("list"))[1]!;
	expect(second).not.toContain("example.test");
	expect(second).toContain('data-question-image="refused"');
	expect(second).toContain(">A tracker<");
	expect(second).toContain("<table>");
});

test("the Decisions tab, the document and the deck show the same visuals", () => {
	let list = previews(render("list"));
	expect(previews(render("inline"))).toEqual(list);
	expect(previews(render("deck"))).toEqual(list);
});

test("an answered card keeps the visual of every option, and the chosen one is still marked", () => {
	let answered: Questionnaire = {
		...OPEN,
		status: "decided",
		by: "ana",
		at: "2026-10-19T10:00:00.000Z",
		questions: [{ ...OPEN.questions[0]!, answer: "Write-through", choices: ["a"] }],
	};
	let decided = { ...META, status: "decided" } as unknown as Question.CardMeta;
	let markup = render("list", answered, decided);
	expect(markup).not.toContain('type="radio"');
	expect(previews(markup)).toEqual(previews(render("list")));
	expect(markup).toContain("Selected: ");
});

test("an option with a visual is named by its label and description, not by the visual's words", () => {
	let markup = render("list");
	let radio = markup.match(/<input[^>]*value="a"[^>]*>/)![0];
	let labelled = radio.match(/aria-labelledby="([^"]+)"/)![1]!.split(" ");
	expect(labelled).toHaveLength(2);
	for (let id of labelled) expect(markup).toContain(`id="${id}"`);
	// The option without a visual keeps the name it always had: its row's own text.
	expect(markup.match(/<input[^>]*value="c"[^>]*>/)![0]).not.toContain("aria-labelledby");
});
