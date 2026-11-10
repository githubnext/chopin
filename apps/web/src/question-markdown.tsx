/**
 * Decision cards read Markdown with Chat's renderer, MarkdownText.
 *
 * The same element allowlist, link handling and continued numbered lists as a
 * Chat message, with two additions a decision needs: a ```mermaid fence draws
 * with the document's own Mermaid renderer (MarkdownText's `componentsByLanguage`),
 * and an image shows only when it is this document's own upload. Raw HTML is shown
 * as the text it was written as, so a question that mentions `<div>` still says so.
 * A card is not a message: its code has no copy header, and its text is read
 * without GitHub's table, strikethrough and autolink syntax, except an option's
 * own visual, which also reads tables.
 */

import { lazy, Suspense, useMemo, useRef, useState } from "react";
import { HOSTED_IMAGE_PATH } from "@chopin/dialect";
import { QuestionMarkdownContext } from "@chopin/question/react";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import { gfmTable } from "micromark-extension-gfm-table";

import { CHAT_COMPONENTS, CHAT_ELEMENTS, MarkdownPhrase } from "./chat/markdown";
import { orderedRunsRemarkPlugin } from "./chat/ordered-runs";
import { MarkdownText } from "./markdown-text/markdown-text";

import type { ReactNode } from "react";
import type { QuestionMarkdownRenderer } from "@chopin/question/react";
import type { MarkdownComponents } from "./chat/markdown";
import type { SyntaxHighlighterProps } from "./markdown-text/markdown-text";

const CardDiagram = lazy(() =>
	import("@chopin/editor/card-diagram").then(({ CardDiagram }) => ({ default: CardDiagram }))
);
const ImageLightbox = lazy(() =>
	import("@chopin/editor/image-lightbox").then(({ ImageLightbox }) => ({ default: ImageLightbox }))
);

const BLOCK_ELEMENTS = [...CHAT_ELEMENTS, "img"];
/** An option's own visual may also be a small table. */
const PREVIEW_ELEMENTS = [...BLOCK_ELEMENTS, "table", "thead", "tbody", "tr", "th", "td"];

/**
 * The URL a card loads an image from, or undefined when the image is not this
 * document's own upload. Only Chopin-hosted paths qualify, and the server
 * serves the scoped URL only from the document named in it.
 */
export function documentImageUrl(src: string | undefined, document: string): string | undefined {
	if (!src || !HOSTED_IMAGE_PATH.test(src)) return undefined;
	return `${src}?document=${encodeURIComponent(document)}`;
}

/**
 * An image, or its alt text in its place when it is refused or fails to load. A loaded image
 * opens large on a click, from its own button, so it never picks the option it sits in.
 */
function CardImage({ alt, document, src }: { alt: string; document: string; src?: string }) {
	let [failed, setFailed] = useState(false);
	let [viewing, setViewing] = useState(false);
	let view = useRef<HTMLButtonElement>(null);
	let url = documentImageUrl(src, document);
	if (!alt.trim()) return null;
	if (!url || failed) {
		return <span className="question-image-alt" data-question-image="refused">{alt}</span>;
	}
	return (
		<>
			<button
				aria-haspopup="dialog"
				aria-label={`View larger: ${alt}`}
				className="question-image-view"
				onClick={() => setViewing(true)}
				ref={view}
				type="button"
			>
				<img
					alt={alt}
					className="question-image"
					data-question-image="document"
					decoding="async"
					loading="lazy"
					onError={() => setFailed(true)}
					src={url}
				/>
			</button>
			{viewing && (
				<Suspense fallback={null}>
					<ImageLightbox
						alt={alt}
						onClose={() => {
							setViewing(false);
							requestAnimationFrame(() => view.current?.focus());
						}}
						src={url}
					/>
				</Suspense>
			)}
		</>
	);
}

/** A card's diagram: the document's own Mermaid renderer, in place of the fence's `pre`. */
function CardMermaid({ code }: SyntaxHighlighterProps) {
	return (
		<Suspense fallback={<div className="question-diagram" data-question-diagram="pending" />}>
			<CardDiagram source={code.replace(/\n$/, "")} />
		</Suspense>
	);
}

let NO_HEADER = () => null;

let MERMAID = { mermaid: { CodeHeader: NO_HEADER, SyntaxHighlighter: CardMermaid } };

function blockComponents(document: string): MarkdownComponents {
	return {
		...CHAT_COMPONENTS,
		CodeHeader: NO_HEADER,
		// A preview's table is its own scrolling lane in the card's styles, so it needs no wrapper.
		table: ({ children }) => <table className="aui-md-table">{children}</table>,
		img: ({ alt, src }) => (
			<CardImage
				alt={alt ?? ""}
				document={document}
				src={typeof src === "string" ? src : undefined}
			/>
		),
	};
}

/** A heading or label is a phrase, so its code spans take the card's own inline-code chip. */
const INLINE_COMPONENTS: MarkdownComponents = {
	...CHAT_COMPONENTS,
	code: ({ children }) => <code className="inline-code">{children}</code>,
};

/** Reads GitHub's pipe tables, and nothing else of GFM, as remark-gfm's table part does. */
function tablesRemarkPlugin(this: { data(): unknown }) {
	let data = this.data() as {
		micromarkExtensions?: unknown[];
		fromMarkdownExtensions?: unknown[];
	};
	(data.micromarkExtensions ??= []).push(gfmTable());
	(data.fromMarkdownExtensions ??= []).push(gfmTableFromMarkdown());
}

type MarkdownNode = { type: string; value?: string; children?: MarkdownNode[] };

/**
 * A line break an agent typed is a line break on the card, as it is in a GitHub comment:
 * "(1) …" on its own line stays on its own line, wherever the card is shown.
 */
export function lineBreaksRemarkPlugin() {
	let walk = (node: MarkdownNode) => {
		if (!node.children) return;
		node.children = node.children.flatMap(child => {
			if (child.type !== "text" || !child.value?.includes("\n")) {
				walk(child);
				return [child];
			}
			return child.value.split("\n").flatMap((line, index): MarkdownNode[] =>
				index === 0
					? [{ type: "text", value: line }]
					: [{ type: "break" }, { type: "text", value: line }]
			);
		});
	};
	return (tree: MarkdownNode) => walk(tree);
}

let PLAIN_BLOCKS = [orderedRunsRemarkPlugin, lineBreaksRemarkPlugin];
let PREVIEW_BLOCKS = [tablesRemarkPlugin, orderedRunsRemarkPlugin, lineBreaksRemarkPlugin];

export function questionMarkdown(document: string): QuestionMarkdownRenderer {
	let components = blockComponents(document);
	return {
		inline: (source, { links }) => (
			<MarkdownPhrase
				components={INLINE_COMPONENTS}
				links={links}
				skipHtml={false}
				source={source}
			/>
		),
		block: (source, place, root) => (
			<MarkdownText
				allowedElements={place === "preview" ? PREVIEW_ELEMENTS : BLOCK_ELEMENTS}
				className={root.className}
				components={components}
				componentsByLanguage={MERMAID}
				containerProps={ROOT_PROPS}
				remarkPlugins={place === "preview" ? PREVIEW_BLOCKS : PLAIN_BLOCKS}
				text={source}
				unwrapDisallowed
			/>
		),
	};
}

let ROOT_PROPS = { "data-question-markdown": "" };

/** Card text in this document renders as Markdown, with this document's images. */
export function QuestionMarkdownProvider(
	{ children, document }: { children: ReactNode; document: string },
) {
	let renderer = useMemo(() => questionMarkdown(document), [document]);
	return (
		<QuestionMarkdownContext.Provider value={renderer}>{children}</QuestionMarkdownContext.Provider>
	);
}
