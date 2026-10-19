/**
 * Decision cards read Markdown with Chat's renderer.
 *
 * The same element allowlist, link handling and continued numbered lists as a
 * Chat message, with two additions a decision needs: a ```mermaid fence draws
 * with the document's own Mermaid renderer, and an image shows only when it is
 * this document's own upload. Raw HTML is shown as the text it was written as,
 * so a question that mentions `<div>` still says so.
 */

import { lazy, Suspense, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import { HOSTED_IMAGE_PATH } from "@chopin/dialect";
import { QuestionMarkdownContext } from "@chopin/question/react";

import { CHAT_COMPONENTS, CHAT_ELEMENTS, CHAT_INLINE, inlineSource } from "./chat/markdown";
import { orderedRunsRemarkPlugin } from "./chat/ordered-runs";

import type { ReactNode } from "react";
import type { Components } from "react-markdown";
import type { QuestionMarkdownRenderer } from "@chopin/question/react";

const CardDiagram = lazy(() =>
	import("@chopin/editor/card-diagram").then(({ CardDiagram }) => ({ default: CardDiagram }))
);

const BLOCK_ELEMENTS = [...CHAT_ELEMENTS, "img"];

/**
 * The URL a card loads an image from, or undefined when the image is not this
 * document's own upload. Only Chopin-hosted paths qualify, and the server
 * serves the scoped URL only from the document named in it.
 */
export function documentImageUrl(src: string | undefined, document: string): string | undefined {
	if (!src || !HOSTED_IMAGE_PATH.test(src)) return undefined;
	return `${src}?document=${encodeURIComponent(document)}`;
}

/** An image, or its alt text in its place when it is refused or fails to load. */
function CardImage({ alt, document, src }: { alt: string; document: string; src?: string }) {
	let [failed, setFailed] = useState(false);
	let url = documentImageUrl(src, document);
	if (!alt.trim()) return null;
	if (!url || failed) {
		return <span className="question-image-alt" data-question-image="refused">{alt}</span>;
	}
	return (
		<img
			alt={alt}
			className="question-image"
			data-question-image="document"
			decoding="async"
			loading="lazy"
			onError={() => setFailed(true)}
			src={url}
		/>
	);
}

function text(node: unknown): string {
	if (!node || typeof node !== "object") return "";
	let value = node as { type?: string; value?: string; children?: unknown[] };
	if (value.type === "text") return value.value ?? "";
	return (value.children ?? []).map(text).join("");
}

function mermaidSource(node: unknown): string | undefined {
	let code = (node as { children?: unknown[] } | undefined)?.children?.[0] as {
		tagName?: string;
		properties?: { className?: unknown };
	} | undefined;
	let classes = code?.tagName === "code" ? code.properties?.className : undefined;
	if (!Array.isArray(classes) || !classes.includes("language-mermaid")) return undefined;
	return text(code).replace(/\n$/, "");
}

function blockComponents(document: string): Components {
	return {
		...CHAT_COMPONENTS,
		img: ({ alt, src }) => (
			<CardImage
				alt={alt ?? ""}
				document={document}
				src={typeof src === "string" ? src : undefined}
			/>
		),
		pre: ({ children, node }) => {
			let source = mermaidSource(node);
			if (source === undefined) return <pre>{children}</pre>;
			return (
				<Suspense fallback={<div className="question-diagram" data-question-diagram="pending" />}>
					<CardDiagram source={source} />
				</Suspense>
			);
		},
	};
}

/** A heading or label is a phrase, so its code spans take the card's own inline-code chip. */
const INLINE_COMPONENTS: Components = {
	...CHAT_COMPONENTS,
	code: ({ children }) => <code className="inline-code">{children}</code>,
};

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

export function questionMarkdown(document: string): QuestionMarkdownRenderer {
	let components = blockComponents(document);
	return {
		inline: (source, { links }) => (
			<ReactMarkdown
				allowedElements={links ? CHAT_INLINE : CHAT_INLINE.filter(name => name !== "a")}
				components={INLINE_COMPONENTS}
				unwrapDisallowed
			>
				{inlineSource(source)}
			</ReactMarkdown>
		),
		block: source => (
			<ReactMarkdown
				allowedElements={BLOCK_ELEMENTS}
				components={components}
				remarkPlugins={[orderedRunsRemarkPlugin, lineBreaksRemarkPlugin]}
				unwrapDisallowed
			>
				{source}
			</ReactMarkdown>
		),
	};
}

/** Card text in this document renders as Markdown, with this document's images. */
export function QuestionMarkdownProvider(
	{ children, document }: { children: ReactNode; document: string },
) {
	let renderer = useMemo(() => questionMarkdown(document), [document]);
	return (
		<QuestionMarkdownContext.Provider value={renderer}>{children}</QuestionMarkdownContext.Provider>
	);
}
