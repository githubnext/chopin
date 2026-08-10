import ReactMarkdown from "react-markdown";

import "./markdown.css";

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

/** The deliberately small Markdown dialect understood by conversation. */
export function MessageMarkdown({ source }: { source: string }) {
	return (
		<div className="chat-markdown" data-chat-markdown>
			<ReactMarkdown
				allowedElements={ELEMENTS}
				components={COMPONENTS}
				skipHtml
				unwrapDisallowed
			>
				{source}
			</ReactMarkdown>
		</div>
	);
}
