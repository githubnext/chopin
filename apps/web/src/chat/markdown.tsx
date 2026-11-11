import { createContext, memo, useContext, useDeferredValue, useMemo, useRef } from "react";
import { useLinkHref } from "@chopin/editor";
import { messageGfmRemarkPlugin } from "../markdown-text/gfm";
import { MarkdownText } from "../markdown-text/markdown-text";
import { sameJson } from "../same-json";
import { orderedRunsRemarkPlugin } from "./ordered-runs";
import { referenceRemarkPlugin } from "./reference-markdown";
import { referenceRenderModel } from "./references";
import "./markdown.css";

import type { ComponentProps, ReactNode } from "react";
import type { Chat } from "@chopin/protocol";
import type { MarkdownTextProps } from "../markdown-text/markdown-text";
import type { ReferenceRenderModel } from "./references";

/** MarkdownText's `components` prop: the elements a surface draws its own way. */
export type MarkdownComponents = NonNullable<MarkdownTextProps["components"]>;

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

/** What a message may also say: GitHub's tables, strikethrough and task lists. */
export const MESSAGE_ELEMENTS = [
	...CHAT_ELEMENTS,
	"del",
	"input",
	"table",
	"tbody",
	"td",
	"th",
	"thead",
	"tr",
];

/** A heading in Chat is a line of text: a message has no document structure. */
let paragraph = ({ children }: ComponentProps<"p">) => <p className="aui-md-p">{children}</p>;

/** A link someone wrote: a path in the repository opens the file on GitHub, as in the document. */
export const ChatLink = ({ children, className, href }: ComponentProps<"a">) => (
	<a
		className={["aui-md-a", className].filter(Boolean).join(" ")}
		href={useLinkHref(href)}
		rel="noopener noreferrer"
		target="_blank"
	>
		{children}
	</a>
);

export const CHAT_COMPONENTS: MarkdownComponents = {
	a: ChatLink,
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

let NO_PLUGINS: never[] = [];

/** The root of a phrase: its content and nothing around it, so the root adds no element. */
function PhraseRoot({ children }: { children?: ReactNode }) {
	return <>{children}</>;
}

/**
 * One line of text, drawn as its own nodes with no element around them, which is how a phrase
 * sat in its heading, label or paragraph before MarkdownText. Raw HTML is dropped when
 * `skipHtml` is set, and shown as the text it was written as when it is not.
 */
export function MarkdownPhrase(
	{ components, links, skipHtml, source }: {
		components: MarkdownComponents;
		links: boolean;
		skipHtml: boolean;
		source: string;
	},
) {
	return (
		<MarkdownText
			allowedElements={links ? CHAT_INLINE : INLINE_WITHOUT_LINKS}
			components={components}
			containerComponent={PhraseRoot}
			defer={false}
			remarkPlugins={NO_PLUGINS}
			skipHtml={skipHtml}
			text={inlineSource(source)}
			unwrapDisallowed
		/>
	);
}

let INLINE_WITHOUT_LINKS = CHAT_INLINE.filter(name => name !== "a");

/**
 * One line of agent-written text, such as a task's title or criterion, with Chat's inline
 * Markdown: code spans, emphasis and links. Pass `links={false}` inside another control.
 */
export function InlineMarkdown({ links = true, source }: { links?: boolean; source: string }) {
	return <MarkdownPhrase components={CHAT_COMPONENTS} links={links} skipHtml source={source} />;
}

type MessageMarkdownProps = {
	className?: string;
	/** Inline lead drawn before the first paragraph, styled as a mention. */
	mention?: string;
	references?: Chat.Reference[];
	source: string;
	/** The Planner is still writing this message: its root says so as `data-status="running"`. */
	streaming?: boolean;
};

/**
 * Whether a message's Markdown needs drawing again. Parsing it is the cost of a row, and the room
 * renders the transcript for reasons that have nothing to do with any message, so a message is
 * drawn again only when what it says changes. A message to the Planner hands over its references
 * as a new list on every render, so they are compared by what they say.
 */
export function sameMessageMarkdown(
	before: MessageMarkdownProps,
	after: MessageMarkdownProps,
): boolean {
	return before.source === after.source && before.className === after.className
		&& before.mention === after.mention && !before.streaming === !after.streaming
		&& sameJson(before.references, after.references);
}

/** The references of the message being drawn, which its links read to become chips. */
let References = createContext<ReferenceRenderModel["references"]>([]);

/** A typed reference is a chip; any other link is as written. */
function MessageLink(props: ComponentProps<"a">) {
	let references = useContext(References);
	let attributes = props as Record<string, unknown>;
	let property = attributes["data-chat-reference-index"] ?? attributes["dataChatReferenceIndex"];
	let index = typeof property === "string" ? Number(property) : -1;
	let reference = Number.isSafeInteger(index) ? references[index] : undefined;
	if (!reference) return <ChatLink href={props.href}>{props.children}</ChatLink>;
	return reference.kind !== "document"
		? <span className="chat-reference" data-chat-reference={reference.kind}>{reference.label}</span>
		: (
			<a className="chat-reference" data-chat-reference={reference.kind} href={reference.href}>
				{reference.label}
			</a>
		);
}

/** A task list's box shows its state and is never a control; its name is what a reader hears first. */
function TaskBox({ checked }: ComponentProps<"input">) {
	return <input aria-label="Task" checked={!!checked} disabled readOnly type="checkbox" />;
}

let MESSAGE_COMPONENTS: MarkdownComponents = { ...CHAT_COMPONENTS, a: MessageLink, input: TaskBox };

/** Keeps the identity of the references while what they say is unchanged. */
function useSame<T>(value: T): T {
	let held = useRef(value);
	if (!sameJson(held.current, value)) held.current = value;
	return held.current;
}

/** The deliberately small Markdown dialect understood by Chat. */
export const MessageMarkdown = memo(function MessageMarkdown(
	{ className, mention, references, source, streaming }: MessageMarkdownProps,
) {
	// The text a parse reads and the plugins that know its references come from the same source, so
	// the deferral is made here: MarkdownText's own would parse the previous text with the next
	// plugins first, and then the next text again, on every streamed delta.
	let deferred = useDeferredValue(source);
	let held = useSame(references);
	let model = useMemo(() => referenceRenderModel(deferred, held), [deferred, held]);
	let remarkPlugins = useMemo(() => {
		let gfm = messageGfmRemarkPlugin(model.source);
		return [...(gfm ? [gfm] : []), [referenceRemarkPlugin, model], orderedRunsRemarkPlugin];
	}, [model]);
	return (
		<References.Provider value={model.references}>
			<MarkdownText
				allowedElements={MESSAGE_ELEMENTS}
				className={["chat-markdown", className].filter(Boolean).join(" ")}
				components={MESSAGE_COMPONENTS}
				containerProps={{
					"data-chat-markdown": "",
					"data-chat-mention-lead": mention ? "" : undefined,
				}}
				lead={mention
					? (
						<>
							<span className="chat-mention">{mention}</span>
							{" "}
						</>
					)
					: undefined}
				defer={false}
				remarkPlugins={remarkPlugins as MarkdownTextProps["remarkPlugins"]}
				skipHtml
				status={streaming ? "running" : "complete"}
				text={model.source}
				unwrapDisallowed
			/>
		</References.Provider>
	);
}, sameMessageMarkdown);
