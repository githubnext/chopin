import ReactMarkdown from "react-markdown";

import { referenceRemarkPlugin } from "./reference-markdown";
import { referenceRenderModel } from "./references";
import "./markdown.css";

import type { Chat } from "@chopin/protocol";
import type { Components } from "react-markdown";

let ELEMENTS = [
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

let COMPONENTS: Components = {
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
		...COMPONENTS,
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
				allowedElements={ELEMENTS}
				components={components}
				remarkPlugins={[[referenceRemarkPlugin, model]]}
				skipHtml
				unwrapDisallowed
			>
				{model.source}
			</ReactMarkdown>
		</div>
	);
}
