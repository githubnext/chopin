import ReactMarkdown from "react-markdown";

import { orderedRunsRemarkPlugin } from "./ordered-runs";
import { referenceRemarkPlugin } from "./reference-markdown";
import { referenceRenderModel } from "./references";
import "./markdown.css";

import type { Chat } from "@chopin/protocol";
import type { Components } from "react-markdown";

export const CHAT_ELEMENTS = [
	"a",
	"blockquote",
	"br",
	"code",
	"em",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"li",
	"ol",
	"p",
	"pre",
	"strong",
	"ul",
];

let paragraph: NonNullable<Components["p"]> = ({ children }) => <p>{children}</p>;

export const CHAT_COMPONENTS: Components = {
	a: ({ children, href }) => (
		<a href={href} rel="noopener noreferrer" target="_blank">
			{children}
		</a>
	),
	h1: paragraph,
	h2: paragraph,
	h3: paragraph,
	h4: paragraph,
	h5: paragraph,
	h6: paragraph,
};

export const CHAT_INLINE = ["a", "code", "em", "strong"];

/** Escapes what would open a block at the start of a line, so one line stays one line of text. */
export function inlineSource(source: string): string {
	let text = source.replace(/\s+/g, " ").trim();
	if (/^([-*_])( ?\1){2,}$/.test(text)) return `\\${text}`;
	return text
		.replace(/^(\d{1,9})([.)])(?= |$)/, "$1\\$2")
		.replace(/^([-+*]|#{1,6})(?= |$)/, "\\$1")
		.replace(/^>/, "\\>");
}

/**
 * One line of agent-written text, such as a task's title or criterion, with Chat's inline
 * Markdown: code spans, emphasis and links. Pass `links={false}` inside another control.
 */
export function InlineMarkdown({ links = true, source }: { links?: boolean; source: string }) {
	return (
		<ReactMarkdown
			allowedElements={links ? CHAT_INLINE : CHAT_INLINE.filter(name => name !== "a")}
			components={CHAT_COMPONENTS}
			skipHtml
			unwrapDisallowed
		>
			{inlineSource(source)}
		</ReactMarkdown>
	);
}

/** The deliberately small Markdown dialect understood by Chat. */
export function MessageMarkdown(
	{
		className,
		mention,
		references,
		source,
	}: {
		className?: string;
		/** Inline lead drawn before the first paragraph, styled as a mention. */
		mention?: string;
		references?: Chat.Reference[];
		source: string;
	},
) {
	let model = referenceRenderModel(source, references);
	let components: Components = {
		...CHAT_COMPONENTS,
		a: ({ children, href, node }) => {
			let property = node?.properties?.dataChatReferenceIndex
				?? node?.properties?.["data-chat-reference-index"];
			let index = typeof property === "string" ? Number(property) : -1;
			let reference = Number.isSafeInteger(index) ? model.references[index] : undefined;
			return reference
				? reference.kind === "research"
					? (
						<span
							className="chat-reference"
							data-chat-reference="research"
						>
							{reference.label}
						</span>
					)
					: (
						<a
							className="chat-reference"
							data-chat-reference={reference.kind}
							href={reference.href}
						>
							{reference.label}
						</a>
					)
				: (
					<a href={href} rel="noopener noreferrer" target="_blank">
						{children}
					</a>
				);
		},
	};
	return (
		<div
			className={`chat-markdown ${className ?? ""}`}
			data-chat-markdown
			data-chat-mention-lead={mention ? "" : undefined}
		>
			{mention && (
				<>
					<span className="chat-mention">{mention}</span>
					{" "}
				</>
			)}
			<ReactMarkdown
				allowedElements={CHAT_ELEMENTS}
				components={components}
				remarkPlugins={[[referenceRemarkPlugin, model], orderedRunsRemarkPlugin]}
				skipHtml
				unwrapDisallowed
			>
				{model.source}
			</ReactMarkdown>
		</div>
	);
}
