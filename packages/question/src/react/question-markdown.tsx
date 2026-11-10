/**
 * Card text as Markdown.
 *
 * A question's heading, body, description and options are Markdown. The
 * application renders it with the same safe renderer Chat uses and provides
 * that renderer here, so this package needs no Markdown parser of its own. A
 * view mounted without one, such as a test or a static fixture, keeps the
 * plain rendering every card had before: code spans, with line breaks kept.
 */

import { createContext, useContext } from "react";

import { multiline } from "../text";
import { InlineCode } from "./inline-code";

import type { ReactNode } from "react";

export type QuestionMarkdownRenderer = {
	/** One line: code spans, emphasis and, unless `links` is false, links. Never a block. */
	inline: (source: string, options: { links: boolean }) => ReactNode;
	/**
	 * Several lines: paragraphs, lists, code, diagrams and the document's own images. An option's
	 * own visual (`place` "preview") also draws tables. The renderer draws the element that holds
	 * them, with `root` as its class and attributes, so the blocks are its direct children.
	 */
	block: (source: string, place: MarkdownPlace, root: MarkdownRoot) => ReactNode;
};

/** The class and attributes of the element that holds a card's Markdown blocks. */
export type MarkdownRoot = { className: string; "data-question-markdown": "" };

export const QuestionMarkdownContext = createContext<QuestionMarkdownRenderer | undefined>(
	undefined,
);

/** One line of card text, such as a heading or an option's label. Phrasing content only. */
export function MarkdownLine({ links = true, text }: { links?: boolean; text: string }) {
	let renderer = useContext(QuestionMarkdownContext);
	return renderer ? renderer.inline(text, { links }) : <InlineCode text={text} />;
}

/**
 * Where card Markdown sits: a question's body, its description, an option's description, an
 * option's own visual, or a decision page's body.
 */
export type MarkdownPlace = "body" | "hint" | "desc" | "preview" | "page";

/** Constants, so a renderer that memoizes on its props sees the same root each time. */
let ROOTS: Record<MarkdownPlace, MarkdownRoot> = {
	body: { className: "question-body", "data-question-markdown": "" },
	hint: { className: "question-hint", "data-question-markdown": "" },
	desc: { className: "question-desc", "data-question-markdown": "" },
	preview: { className: "question-preview-body", "data-question-markdown": "" },
	page: { className: "question-body question-page-body", "data-question-markdown": "" },
};

/** Markdown blocks, in an element of their own. */
export function MarkdownBlocks({ place, text }: { place: MarkdownPlace; text: string }) {
	let renderer = useContext(QuestionMarkdownContext);
	return renderer ? renderer.block(text, place, ROOTS[place]) : (
		<div
			className={place === "body"
				? "question-body"
				: place === "hint"
				? "question-hint"
				: place === "desc"
				? "question-desc"
				: place === "preview"
				? "question-preview-body"
				: "question-body question-page-body"}
			data-question-markdown=""
		>
			<PlainBlocks text={text} />
		</div>
	);
}

/**
 * A description that may be one line or several: one line stays a phrase, as
 * it always was; several become Markdown blocks.
 */
export function MarkdownText({ place, text }: { place: "hint" | "desc"; text: string }) {
	if (multiline(text)) return <MarkdownBlocks place={place} text={text} />;
	return place === "hint"
		? (
			<p className="question-hint">
				<MarkdownLine text={text} />
			</p>
		)
		: (
			<span className="question-desc">
				<MarkdownLine text={text} />
			</span>
		);
}

function PlainBlocks({ text }: { text: string }) {
	return (
		<>
			{text.trim().split(/\n\s*\n/).map((paragraph, index) => (
				<p className="question-plain-lines" key={index}>
					<InlineCode text={paragraph} />
				</p>
			))}
		</>
	);
}
