import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RepositoryLinksProvider } from "@chopin/editor";
import { QuestionView } from "@chopin/question/react";

import { documentImageUrl, QuestionMarkdownProvider } from "./question-markdown";

import type { QuestionViewProps } from "@chopin/question/react";

const DOCUMENT = "0b5c6f0e-8d0e-4d7e-9a43-5d4c4a8f1b2e";
const IMAGE = `/images/${"a".repeat(64)}.png`;
const P_CLASS = "aui-md-p my-3 leading-relaxed first:mt-0 last:mb-0";
const STRONG_CLASS = "aui-md-strong font-semibold";
const A_CLASS = "aui-md-a text-primary hover:text-primary/80 underline underline-offset-2";
const CODE_CLASS = "aui-md-inline-code bg-muted rounded-md px-1.5 py-0.5 font-mono text-[0.85em]";
const UL_CLASS = "aui-md-ul marker:text-muted-foreground my-3 ms-5 list-disc [&amp;&gt;li]:mt-1";
const OL_CLASS = "aui-md-ol marker:text-muted-foreground my-3 ms-5 list-decimal [&amp;&gt;li]:mt-1";
const LI_CLASS = "aui-md-li leading-relaxed";
const PRE_CLASS =
	"aui-md-pre border-border/50 bg-muted/30 overflow-x-auto rounded-t-none rounded-b-xl border border-t-0 p-3.5 text-[13px] leading-relaxed";

function card(question: string, extra: Partial<QuestionViewProps> = {}, item: object = {}) {
	let definition = {
		questions: [{
			id: "q",
			header: "Check",
			question,
			multiple: false,
			options: [
				{ id: "a", label: "Keep them", description: "" },
				{ id: "b", label: "Change some", description: "" },
			],
			...item,
		}],
	};
	return renderToStaticMarkup(
		<QuestionMarkdownProvider document={DOCUMENT}>
			<QuestionView definition={definition} drafts={{}} {...extra} />
		</QuestionMarkdownProvider>,
	);
}

function heading(markup: string): string {
	return markup.slice(markup.indexOf("<h4"), markup.indexOf("</h4>") + 5);
}

test("a plain one-line question reads exactly as before", () => {
	expect(heading(card("What auth system should we use?"))).toBe(
		'<h4 class="question-title" id="_R_0_-title-q"><span class="question-title-link">What auth system should we use?</span></h4>',
	);
});

test("stray stars, underscores and numbers in a plain question stay text", () => {
	for (
		let plain of [
			"1. Use *nix paths, snake_case_names or 2 * 3?",
			"- Keep the old flow?",
			"Run make_target_a then make_target_b_ after * step?",
		]
	) {
		let markup = heading(card(plain));
		expect(markup).not.toMatch(/<(em|strong|ol|ul|li|p)\b/);
		expect(markup).toContain(plain.replace(/^- /, "- "));
	}
});

test("a question body renders a Markdown list with Chat's renderer under its heading", () => {
	let markup = card(
		"Confirm the earlier answers\n\n- Storage: **PostgreSQL**\n- Rollout: `pilot`\n\nSee [the notes](https://example.com/notes).",
	);
	expect(heading(markup)).toContain(">Confirm the earlier answers</span></h4>");
	expect(markup).toContain(
		`<div data-status="complete" data-question-markdown="" class="question-body aui-md"><ul class="${UL_CLASS}">\n<li class="${LI_CLASS}">Storage: <strong class="${STRONG_CLASS}">PostgreSQL</strong></li>\n<li class="${LI_CLASS}">Rollout: <code class="${CODE_CLASS}">pilot</code></li>\n</ul>`,
	);
	expect(markup).toContain(
		`<a class="${A_CLASS}" href="https://example.com/notes" rel="noopener noreferrer" target="_blank">the notes</a>`,
	);
});

test("the heading carries inline Markdown, but never a block", () => {
	let markup = heading(card("Use `pg` with *pooling* or [a proxy](https://example.com)?"));
	expect(markup).toContain('<code class="inline-code">pg</code>');
	expect(markup).toContain("<em>pooling</em>");
	expect(markup).toContain(`<a class="${A_CLASS}" href="https://example.com"`);
	// Linked to its prose, the heading is a button, which cannot hold a link.
	let linked = heading(card("Read [the notes](https://example.com)?", { places: { q: 1 } }));
	expect(linked).not.toContain("<a ");
	expect(linked).toContain("the notes");
});

test("raw HTML is shown as text, never rendered", () => {
	let markup = card("Replace <div> with <section>?\n\n<script>alert(1)</script>\n\n<b>bold</b>");
	expect(markup).toContain("Replace &lt;div&gt; with &lt;section&gt;?");
	expect(markup).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
	expect(markup).not.toContain("<script");
	expect(markup).not.toContain("<b>");
});

test("only this document's own image loads, and every other image shows its alt text", () => {
	let markup = card(
		[
			"Which layout?",
			"",
			`![Current layout](${IMAGE})`,
			"",
			"![Remote mockup](https://example.com/mockup.png)",
			"",
			"![Inline data](data:image/png;base64,iVBORw0KGgo=)",
			"",
			`![](${IMAGE})`,
		].join("\n"),
	);
	expect(markup).toContain(
		`<img alt="Current layout" class="question-image" data-question-image="document" decoding="async" loading="lazy" src="${IMAGE}?document=${DOCUMENT}"/>`,
	);
	expect(markup.match(/<img /g)).toHaveLength(1);
	expect(markup).toContain('data-question-image="refused">Remote mockup</span>');
	expect(markup).toContain('data-question-image="refused">Inline data</span>');
	expect(markup).not.toContain("example.com/mockup.png");
	expect(markup).not.toContain("data:image");
	expect(documentImageUrl("/images/../secret.png", DOCUMENT)).toBeUndefined();
	expect(documentImageUrl(`https://chopin.test${IMAGE}`, DOCUMENT)).toBeUndefined();
});

test("a mermaid fence becomes a lazily drawn diagram; any other fence stays code", () => {
	let markup = card(
		"Which flow?\n\n- Before: one step\n- After: two\n\n```mermaid\nflowchart LR\n  A[Before] --> B[After]\n```\n\n```ts\nlet a = 1;\n```",
	);
	expect(markup).toContain('data-question-diagram="pending"');
	expect(markup).not.toContain("flowchart LR");
	expect(markup).toContain(
		`<pre class="${PRE_CLASS}"><code class="language-ts">let a = 1;\n</code></pre>`,
	);
});

test("descriptions and option text render through the same renderer", () => {
	let markup = card("Pick a store", {}, {
		description: "Both keep:\n\n1. history\n2. drafts",
		options: [
			{ id: "a", label: "Use **Postgres**", description: "Managed, *familiar*" },
			{ id: "b", label: "SQLite", description: "Trade-offs:\n\n- local\n- small" },
		],
	});
	expect(markup).toContain(
		`<div data-status="complete" data-question-markdown="" class="question-hint aui-md"><p class="${P_CLASS}">Both keep:</p>`,
	);
	expect(markup).toContain(`<ol class="${OL_CLASS}">`);
	expect(markup).toContain(
		`<span class="question-label">Use <strong class="${STRONG_CLASS}">Postgres</strong></span>`,
	);
	expect(markup).toContain(
		'<span class="question-desc">Managed, <em>familiar</em></span>',
	);
	expect(markup).toContain(
		`<div data-status="complete" data-question-markdown="" class="question-desc aui-md"><p class="${P_CLASS}">Trade-offs:</p>`,
	);
});

test("an answered card keeps its rendered body", () => {
	let question = "Confirm the earlier answers\n\n- Storage: PostgreSQL\n- Rollout: pilot";
	let markup = card(question, {
		status: "answered",
		answers: [{ question, optionIds: ["a"], choices: ["Keep them"] }],
	});
	expect(markup).toContain(`<li class="${LI_CLASS}">Storage: PostgreSQL</li>`);
	expect(heading(markup)).not.toContain("Storage");
});

test("a repository path in a decision card opens the file on GitHub", () => {
	let blob = "https://github.com/octo-org/score/blob/main";
	let markup = renderToStaticMarkup(
		<RepositoryLinksProvider value={{ owner: "octo-org", name: "score", ref: "main" }}>
			<QuestionMarkdownProvider document={DOCUMENT}>
				<QuestionView
					definition={{
						questions: [{
							id: "q",
							header: "Check",
							question:
								"Which?\n\nRead [the review](docs/review.md#L10-L20) and [the site](https://example.com).",
							multiple: false,
							options: [{
								id: "a",
								label: "Keep",
								description: "As in [the config](./config/app.toml)",
							}],
						}],
					}}
					drafts={{}}
				/>
			</QuestionMarkdownProvider>
		</RepositoryLinksProvider>,
	);
	expect(markup).toContain(`<a class="${A_CLASS}" href="${blob}/docs/review.md#L10-L20"`);
	expect(markup).toContain(`<a class="${A_CLASS}" href="${blob}/config/app.toml"`);
	expect(markup).toContain(`<a class="${A_CLASS}" href="https://example.com"`);
	expect(card("Read [the review](docs/review.md)")).toContain(
		`<a class="${A_CLASS}" href="docs/review.md"`,
	);
});
