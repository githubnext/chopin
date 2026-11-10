/**
 * MarkdownText: read-only Markdown for Chat and the decision cards, driven by props.
 *
 * The element is assistant-ui's (MIT; https://www.assistant-ui.com/elements/markdown-text). Its
 * page says that standalone it has no controlled form, because the primitive reads its text from the
 * surrounding message part through `useMessagePartText()` and `INTERNAL.useSmooth()` of
 * `@assistant-ui/react`, which need that library's runtime. Chopin's Chat is collaborative and
 * Yjs-backed and has no such runtime, so this is the element's source with that one seam replaced:
 * `text` and `status` are props. See THIRD_PARTY_NOTICES.md for the exact source files and commit.
 *
 * Upstream's, unchanged in behaviour: the `aui-md-*` element set with `components` merged onto it,
 * `componentsByLanguage` and the `CodeHeader`/`SyntaxHighlighter` slots for fenced code,
 * GitHub-flavoured Markdown by default, `data-status` on the root, `className`, `containerProps`
 * (merged with the class) and `containerComponent` of the primitive, `defer`, the deferred and
 * memoized renderer that parses a text once, and the stable-props hooks that keep that memo from
 * missing. Added: `lead`, an inline lead drawn before the first block. Not taken: `smooth`, the
 * typewriter reveal, which is `INTERNAL.useSmooth` of the runtime (Chat draws each streamed delta
 * as it arrives), and `preprocess`, which nothing here uses.
 */

import { createContext, memo, useContext, useDeferredValue, useMemo, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import {
	CodeOverride,
	DefaultCode,
	DefaultCodeBlockContent,
	DefaultCodeHeader,
	DefaultPre,
	PreOverride,
} from "./code-blocks";
import { memoizeMarkdownComponents } from "./memoization";
import { defaultComponents } from "./default-components";
import "./markdown-text.css";

import type { ComponentProps, ComponentType, ElementType, FC, ReactNode } from "react";
import type { Options } from "react-markdown";
import type {
	CodeComponent,
	CodeHeaderProps,
	CodeOverrideProps,
	ComponentsByLanguage,
	PreComponent,
	SyntaxHighlighterProps,
} from "./code-blocks";

export type { CodeHeaderProps, ComponentsByLanguage, SyntaxHighlighterProps } from "./code-blocks";
export { useIsMarkdownCodeBlock } from "./code-blocks";
export { memoizeMarkdownComponents } from "./memoization";

/** `running` while text is still arriving, `complete` once settled, `incomplete` if it ended early. */
export type MarkdownTextStatus = "running" | "complete" | "incomplete";

type UserComponents =
	& NonNullable<Options["components"]>
	& {
		SyntaxHighlighter?: ComponentType<SyntaxHighlighterProps> | undefined;
		CodeHeader?: ComponentType<CodeHeaderProps> | undefined;
	};

export type MarkdownTextProps =
	& Omit<Options, "children" | "components">
	& {
		/** The Markdown source. Upstream reads it from the message part. */
		text: string;
		/** The state of the text, drawn as `data-status` on the root. Settled when omitted. */
		status?: MarkdownTextStatus | undefined;
		/** Merged onto the default `aui-md-*` elements; a missing key keeps the default. */
		components?: Parameters<typeof memoizeMarkdownComponents>[0] | undefined;
		/** Per fence language, for example `{ mermaid: { SyntaxHighlighter: Diagram } }`. */
		componentsByLanguage?: ComponentsByLanguage | undefined;
		className?: string | undefined;
		/** Attributes for the root, such as a surface's `data-*` hooks; its `className` is merged. */
		containerProps?: (Record<string, string | undefined> & { className?: string }) | undefined;
		/** The root's element. A phrase inside a button or heading is drawn in a `span`. */
		containerComponent?: ElementType | undefined;
		/** Drawn inside the root before the Markdown, such as a message's leading @mention. */
		lead?: ReactNode;
		/**
		 * Parse at a lower priority, so a streamed token does not block urgent work. Must stay
		 * constant for the component's lifetime: the deferred path is a separate component.
		 */
		defer?: boolean | undefined;
	};

type MarkdownRendererProps = Omit<Options, "children"> & { text: string };

type CodeOverrideContextValue = Pick<CodeOverrideProps, "components" | "componentsByLanguage">;

let CodeOverrideContext = createContext<CodeOverrideContextValue | null>(null);

let MarkdownCodeOverride: FC<ComponentProps<CodeComponent>> = props => {
	let codeOverrides = useContext(CodeOverrideContext)!;
	return <CodeOverride {...codeOverrides} {...props} />;
};

let MarkdownPreOverride: FC<ComponentProps<PreComponent>> = props => {
	let { components } = useContext(CodeOverrideContext)!;
	return <PreOverride {...props} fallbackPre={components.Pre} />;
};

// react-markdown builds a fresh processor and parses the whole text on every render, so a render
// that carries text it has already parsed is pure waste. The renderer is memoized to bail out
// then, which only holds while its props keep their identity: useStableProps keeps that identity.
let MarkdownRenderer: FC<MarkdownRendererProps> = memo(
	({ text, ...options }) => <ReactMarkdown {...options}>{text}</ReactMarkdown>,
);
MarkdownRenderer.displayName = "MarkdownRenderer";

// `useDeferredValue` schedules a second pass whenever its input changes, so the deferred path is
// its own component and `defer={false}` never mounts it. The urgent pass carries the previous
// text, which the memoized renderer turns into a bail-out rather than a second parse.
let DeferredMarkdownRenderer: FC<MarkdownRendererProps> = ({ text, ...options }) => {
	let deferredText = useDeferredValue(text);
	return <MarkdownRenderer text={deferredText} {...options} />;
};

let isPlainObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** Compares two values structurally to `depth` levels, then by identity. */
let isShallowEqual = (a: unknown, b: unknown, depth = 1): boolean => {
	if (Object.is(a, b)) return true;
	if (depth <= 0) return false;
	if (Array.isArray(a) && Array.isArray(b)) {
		if (a.length !== b.length) return false;
		for (let i = 0; i < a.length; i++) {
			if (!isShallowEqual(a[i], b[i], depth - 1)) return false;
		}
		return true;
	}
	if (isPlainObject(a) && isPlainObject(b)) {
		let keys = Object.keys(a);
		return keys.length === Object.keys(b).length
			&& keys.every(key => Object.hasOwn(b, key) && isShallowEqual(a[key], b[key], depth - 1));
	}
	return false;
};

/** Keeps the identity of a value whose contents are unchanged to `depth`. */
function useStableValue<T>(value: T, depth: number): T {
	let previous = useRef(value);
	if (!isShallowEqual(value, previous.current, depth)) previous.current = value;
	return previous.current;
}

let read = (source: object, key: string) => (source as Record<string, unknown>)[key];

/** Keeps the identity of props whose values did not change, comparing one array level. */
function useStableProps<T extends object>(props: T): T {
	let previous = useRef(props);
	let keys = Object.keys(props);
	let previousKeys = Object.keys(previous.current);
	let unchanged = keys.length === previousKeys.length
		&& keys.every(key =>
			Object.hasOwn(previous.current, key)
			&& isShallowEqual(read(props, key), read(previous.current, key))
		);
	if (!unchanged) previous.current = props;
	return previous.current;
}

let useShallowStable = <T extends Record<string, unknown> | undefined>(value: T): T => {
	let ref = useRef(value);
	if (value !== ref.current) {
		let prev = ref.current;
		let stable = value !== undefined && prev !== undefined
			&& Object.keys(prev).length === Object.keys(value).length
			&& Object.keys(value).every(key => prev[key] === value[key]);
		if (!stable) ref.current = value;
	}
	return ref.current;
};

let GITHUB_FLAVOURED = [remarkGfm];

type MarkdownTextInnerProps =
	& Omit<Options, "children" | "components">
	& {
		text: string;
		components?: UserComponents | undefined;
		componentsByLanguage?: ComponentsByLanguage | undefined;
		defer?: boolean | undefined;
	};

let MarkdownTextInner: FC<MarkdownTextInnerProps> = (
	{ text, components: userComponents, componentsByLanguage, defer = false, ...rest },
) => {
	let {
		pre = DefaultPre,
		code = DefaultCode,
		SyntaxHighlighter = DefaultCodeBlockContent,
		CodeHeader = DefaultCodeHeader,
	} = userComponents ?? {};
	let useCodeOverrideComponents = useMemo(() => ({
		Pre: pre,
		Code: code,
		SyntaxHighlighter,
		CodeHeader,
	}), [pre, code, SyntaxHighlighter, CodeHeader]);

	let codeOverrideContextValue = useStableValue(
		useMemo(() => ({
			components: useCodeOverrideComponents as CodeOverrideContextValue["components"],
			componentsByLanguage,
		}), [useCodeOverrideComponents, componentsByLanguage]),
		3,
	);

	// An inline `components={{ h1: MyH1 }}` is a fresh object on every render, so the merged map is
	// stabilized here; without it the renderer sees a new prop identity every render.
	let components: Options["components"] = useStableProps(
		useMemo(() => {
			let { pre: _pre, code: _code, SyntaxHighlighter: _s, CodeHeader: _h, ...componentsRest } =
				userComponents ?? {};
			return { ...componentsRest, pre: MarkdownPreOverride, code: MarkdownCodeOverride };
		}, [userComponents]),
	);

	let Renderer = defer ? DeferredMarkdownRenderer : MarkdownRenderer;
	let stableRest = useStableProps(rest);

	return (
		<CodeOverrideContext.Provider value={codeOverrideContextValue}>
			<Renderer components={components} text={text} {...stableRest} />
		</CodeOverrideContext.Provider>
	);
};

let MarkdownTextImpl: FC<MarkdownTextProps> = (
	{
		className,
		components,
		componentsByLanguage,
		containerComponent: Container = "div",
		containerProps,
		defer = true,
		lead,
		remarkPlugins = GITHUB_FLAVOURED,
		status = "complete",
		text,
		...rest
	},
) => {
	let stableComponents = useShallowStable(components);
	let stableComponentsByLanguage = useShallowStable(componentsByLanguage);
	let markdownComponents = useMemo(() => {
		if (!stableComponents) return defaultComponents;
		return { ...defaultComponents, ...memoizeMarkdownComponents(stableComponents) };
	}, [stableComponents]);

	let { className: containerClassName, ...attributes } = containerProps ?? {};
	return (
		<Container
			data-status={status}
			{...attributes}
			className={[className, "aui-md", containerClassName].filter(Boolean).join(" ")}
		>
			{lead}
			<MarkdownTextInner
				components={markdownComponents as UserComponents}
				componentsByLanguage={stableComponentsByLanguage}
				defer={defer}
				remarkPlugins={remarkPlugins}
				text={text}
				{...rest}
			/>
		</Container>
	);
};

export let MarkdownText = memo(MarkdownTextImpl);
