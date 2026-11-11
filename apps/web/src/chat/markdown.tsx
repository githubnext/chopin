import {
	Children,
	createContext,
	isValidElement,
	memo,
	useContext,
	useDeferredValue,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { CheckIcon, CopyIcon } from "lucide-react";
import { defaultUrlTransform } from "react-markdown";
import { useLinkHref } from "@chopin/editor";
import { WarningIcon } from "@chopin/icons";

import {
	CodeHeader,
	defaultComponents,
	MarkdownText,
} from "@/components/assistant-ui/elements/markdown-text";
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import { sameJson } from "../same-json";
import { messageGfmRemarkPlugin } from "./gfm";
import { ChatImage, MessageImages, useImageHost } from "./image";
import { ImageGallery } from "./image-gallery";
import {
	imageBlocksRemarkPlugin,
	imageGalleriesRemarkPlugin,
	imagesOutOfLinksRemarkPlugin,
} from "./image-markdown";
import { isDataImage } from "./image-state";
import { orderedRunsRemarkPlugin } from "./ordered-runs";
import { referenceRemarkPlugin } from "./reference-markdown";
import { referenceRenderModel } from "./references";
import "./markdown.css";

import type { ComponentProps, ReactNode } from "react";
import type { Chat } from "@chopin/protocol";
import type { MarkdownTextProps } from "@/components/assistant-ui/elements/markdown-text";
import type { CodeHeaderProps } from "./assistant-ui/markdown-primitive";
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
	"img",
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
	"figure",
	"input",
	"table",
	"tbody",
	"td",
	"th",
	"thead",
	"tr",
];

let UpstreamParagraph = defaultComponents.p!;
let UpstreamLink = defaultComponents.a!;

/** A heading in Chat is a line of text: a message has no document structure. */
let paragraph = ({ children }: ComponentProps<"p">) => (
	<UpstreamParagraph>{children}</UpstreamParagraph>
);

/** A link someone wrote: a path in the repository opens the file on GitHub, as in the document. */
export const ChatLink = (
	{ "aria-label": label, children, className, href }: ComponentProps<"a">,
) => (
	<UpstreamLink
		aria-label={label}
		className={className}
		href={useLinkHref(href)}
		rel="noopener noreferrer"
		target="_blank"
	>
		{children}
	</UpstreamLink>
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
	if (!reference) {
		return <ChatLink aria-label={props["aria-label"]} href={props.href}>{props.children}</ChatLink>;
	}
	return reference.kind !== "document"
		? <span className="chat-reference" data-chat-reference={reference.kind}>{reference.label}</span>
		: (
			<a
				className="chat-reference"
				data-chat-reference={reference.kind}
				data-chopin-control=""
				href={reference.href}
			>
				{reference.label}
			</a>
		);
}

/** A task list's box shows its state and is never a control; its name is what a reader hears first. */
function TaskBox({ checked }: ComponentProps<"input">) {
	return <input aria-label="Task" checked={!!checked} disabled readOnly type="checkbox" />;
}

/** How long the copy button shows its check or warning after a copy attempt, as upstream's does. */
const COPIED_MS = 3000;

/**
 * Chat's code header: upstream's `CodeHeader` and `TooltipIconButton` at their exact geometry,
 * naming `Copy code`, `Copied` and `Couldn't copy` (with a danger warning glyph on touch where no
 * tooltip opens) when a page has no clipboard or the browser refuses the write.
 */
function ChatCodeHeader({ code, language }: Omit<CodeHeaderProps, "node">) {
	let [outcome, setOutcome] = useState<"copied" | "failed">();
	let timer = useRef<ReturnType<typeof setTimeout>>(undefined);
	useEffect(() => () => clearTimeout(timer.current), []);
	let copy = () => {
		if (!code || outcome === "copied") return;
		let done = (next: "copied" | "failed") => {
			setOutcome(next);
			clearTimeout(timer.current);
			timer.current = setTimeout(() => setOutcome(undefined), COPIED_MS);
		};
		try {
			if (!navigator.clipboard) {
				done("failed");
				return;
			}
			navigator.clipboard.writeText(code).then(() => done("copied"), () => done("failed"));
		} catch {
			done("failed");
		}
	};
	let label = outcome === "copied"
		? "Copied"
		: outcome === "failed"
		? "Couldn't copy"
		: "Copy code";
	return (
		<CodeHeader
			action={
				<TooltipIconButton onClick={copy} tooltip={label}>
					{outcome === "copied"
						? <CheckIcon aria-hidden="true" />
						: outcome === "failed"
						? <WarningIcon aria-hidden="true" className="icon-danger" />
						: <CopyIcon aria-hidden="true" />}
				</TooltipIconButton>
			}
			code={code}
			language={language}
		/>
	);
}

/** A `p` may not hold the block an image is, so a paragraph with an image is a `div`. */
let imageParagraph = (props: ComponentProps<"p">) => {
	let marked = props as Record<string, unknown>;
	return marked["data-chat-image-block"] !== undefined || marked.dataChatImageBlock !== undefined
		? <div className="chat-markdown-paragraph">{props.children}</div>
		: <UpstreamParagraph>{props.children}</UpstreamParagraph>;
};

let imageUrl = (url: string, key: string) =>
	key === "src" && isDataImage(url) ? url : defaultUrlTransform(url);

let caption = (title: unknown) => typeof title === "string" && title.trim() ? title : undefined;

let markdownImage = ({ alt, src, title }: ComponentProps<"img">) => (
	<ChatImage
		image={{
			src: typeof src === "string" ? src : "",
			alt: alt ?? undefined,
			caption: caption(title),
		}}
	/>
);

/** The pictures a gallery holds are its `img` children, whose props are what the Markdown wrote. */
let markdownGallery = ({ children }: ComponentProps<"figure">) => {
	let images = Children.toArray(children).flatMap(child =>
		isValidElement<ComponentProps<"img">>(child) && typeof child.props.src === "string"
			? [{
				src: child.props.src,
				alt: child.props.alt ?? undefined,
				caption: caption(child.props.title),
			}]
			: []
	);
	return <ImageGallery images={images} />;
};
let DefaultPre = defaultComponents.pre!;

/**
 * Upstream's code block, reachable by the keyboard: its lines scroll sideways once the message is
 * narrower than they are, as it is beside the toolbar kept in view on a tall message.
 */
function CodeBlock(props: ComponentProps<typeof DefaultPre>) {
	return <DefaultPre {...props} tabIndex={0} />;
}

let DefaultTable = defaultComponents.table!;

/**
 * Upstream's table, its scroll lane reachable by the keyboard once the table is wider than the
 * message. The copied lane takes no props of its own, so the table, which it holds alone, marks it.
 */
function TableLane(props: ComponentProps<typeof DefaultTable>) {
	return <DefaultTable {...props} ref={keyboardLane} />;
}

function keyboardLane(table: HTMLTableElement | null) {
	table?.parentElement?.setAttribute("tabindex", "0");
}

let MESSAGE_COMPONENTS: MarkdownComponents = {
	...CHAT_COMPONENTS,
	CodeHeader: ChatCodeHeader,
	a: MessageLink,
	figure: markdownGallery,
	h1: imageParagraph,
	h2: imageParagraph,
	h3: imageParagraph,
	h4: imageParagraph,
	h5: imageParagraph,
	h6: imageParagraph,
	img: markdownImage,
	input: TaskBox,
	p: imageParagraph,
	pre: CodeBlock,
	table: TableLane,
};

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
		return [
			...(gfm ? [gfm] : []),
			[referenceRemarkPlugin, model],
			orderedRunsRemarkPlugin,
			imagesOutOfLinksRemarkPlugin,
			imageGalleriesRemarkPlugin,
			imageBlocksRemarkPlugin,
		];
	}, [model]);
	let host = useImageHost();
	let body = (
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
				urlTransform={imageUrl}
			/>
		</References.Provider>
	);
	return host ? body : <MessageImages>{body}</MessageImages>;
}, sameMessageMarkdown);
