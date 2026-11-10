/**
 * Fenced code: the language dispatch, the header slot and the `pre`/`code` pair.
 *
 * Adapted from assistant-ui (MIT) at f92028b4 (see THIRD_PARTY_NOTICES.md), from
 * packages/react-markdown/src: code-fence.ts (3453b39f), overrides/types.ts (bf0a6c5e),
 * overrides/PreOverride.tsx (10a778e2), overrides/CodeOverride.tsx (556ff6f8),
 * overrides/CodeBlock.tsx (23743f45), overrides/defaultComponents.tsx (299b9b1d) and
 * overrides/withDefaults.ts. Changed from upstream: the hast `Element` type comes from
 * react-markdown, and `classnames` is a one-line join. Behaviour is the same.
 */

import { createContext, isValidElement, memo, useContext, useMemo } from "react";

import { memoCompareNodes } from "./memoization";

import type { ComponentPropsWithoutRef, ComponentType, FC, ReactNode } from "react";
import type { HastElement } from "./memoization";

export type PreComponent = ComponentType<
	ComponentPropsWithoutRef<"pre"> & { node?: HastElement | undefined }
>;

export type CodeComponent = ComponentType<
	ComponentPropsWithoutRef<"code"> & { node?: HastElement | undefined }
>;

export type CodeHeaderProps = {
	node?: HastElement | undefined;
	language: string | undefined;
	code: string;
};

export type SyntaxHighlighterProps = {
	node?: HastElement | undefined;
	components: { Pre: PreComponent; Code: CodeComponent };
	language: string;
	code: string;
};

export type ComponentsByLanguage = Record<
	string,
	{
		CodeHeader?: ComponentType<CodeHeaderProps> | undefined;
		SyntaxHighlighter?: ComponentType<SyntaxHighlighterProps> | undefined;
	}
>;

let parseLanguageClass = (className: string | undefined): string =>
	/(?:^|\s)language-([^\s]+)/.exec(className ?? "")?.[1] ?? "";

let join = (...names: (string | undefined)[]) => names.filter(Boolean).join(" ");

let withDefaultProps = <TProps extends { className?: string | undefined }>(
	{ className, ...defaultProps }: Partial<TProps>,
) =>
({ className: classNameProp, ...props }: TProps) => {
	return { className: join(className, classNameProp), ...defaultProps, ...props } as TProps;
};

export let DefaultPre: PreComponent = ({ node: _node, ...rest }) => <pre {...rest} />;

export let DefaultCode: CodeComponent = ({ node: _node, ...rest }) => <code {...rest} />;

export let DefaultCodeBlockContent: ComponentType<{
	node: HastElement | undefined;
	components: { Pre: PreComponent; Code: CodeComponent };
	code: string | ReactNode | undefined;
}> = ({ node, components: { Pre, Code }, code }) => (
	<Pre>
		<Code node={node}>{code}</Code>
	</Pre>
);

export let DefaultCodeHeader: ComponentType<CodeHeaderProps> = () => null;

// --- the `pre` that owns a code block ---------------------------------------------------------

let PreContext = createContext<Omit<ComponentPropsWithoutRef<PreComponent>, "children"> | null>(
	null,
);

/** True inside a fenced or indented block: the `code` there is the block's, not an inline span. */
export let useIsMarkdownCodeBlock = () => useContext(PreContext) !== null;

type PreOverrideProps = ComponentPropsWithoutRef<PreComponent> & { fallbackPre: PreComponent };

let PreOverrideImpl = ({ children, fallbackPre: FallbackPre, ...rest }: PreOverrideProps) => {
	// The pre element is re-emitted by CodeOverride, which only runs for a code child. A pre
	// without one would otherwise lose its element entirely.
	let hasCodeChild =
		rest.node?.children.some(child => child.type === "element" && child.tagName === "code") ?? true;
	if (!hasCodeChild) return <FallbackPre {...rest}>{children}</FallbackPre>;
	return <PreContext.Provider value={rest}>{children}</PreContext.Provider>;
};

export let PreOverride = memo(
	PreOverrideImpl,
	(prev, next) => prev.fallbackPre === next.fallbackPre && memoCompareNodes(prev, next),
);

// --- the `code` that draws a block ------------------------------------------------------------

type CodeRenderContextValue = {
	Pre: PreComponent;
	Code: CodeComponent;
	preProps: Omit<ComponentPropsWithoutRef<PreComponent>, "children">;
	codeProps: ComponentPropsWithoutRef<CodeComponent>;
};

let CodeRenderContext = createContext<CodeRenderContextValue | null>(null);

function WrappedPre(props: ComponentPropsWithoutRef<PreComponent>) {
	let { Pre, preProps } = useContext(CodeRenderContext)!;
	return <Pre {...withDefaultProps<any>(preProps)(props)} />;
}

function WrappedCode(props: ComponentPropsWithoutRef<CodeComponent>) {
	let { Code, codeProps } = useContext(CodeRenderContext)!;
	return <Code {...withDefaultProps<any>(codeProps)(props)} />;
}

function extractCode(children: unknown): string {
	if (typeof children === "string") return children;
	if (Array.isArray(children)) {
		let code = "";
		for (let child of children) code += extractCode(child);
		return code;
	}
	if (isValidElement<{ children?: unknown }>(children)) return extractCode(children.props.children);
	return "";
}

type CodeBlockProps = {
	node: HastElement | undefined;
	language: string;
	code: string;
	components: {
		Pre: PreComponent;
		Code: CodeComponent;
		CodeHeader: ComponentType<CodeHeaderProps>;
		SyntaxHighlighter: ComponentType<SyntaxHighlighterProps>;
	};
};

let DefaultCodeBlock: FC<CodeBlockProps> = (
	{ node, components: { Pre, Code, SyntaxHighlighter, CodeHeader }, language, code },
) => {
	let components = useMemo(() => ({ Pre, Code }), [Pre, Code]);
	return (
		<>
			<CodeHeader code={code} language={language} node={node} />
			<SyntaxHighlighter code={code} components={components} language={language} node={node} />
		</>
	);
};

export type CodeOverrideProps = ComponentPropsWithoutRef<CodeComponent> & {
	components: {
		Pre: PreComponent;
		Code: CodeComponent;
		CodeHeader: ComponentType<CodeHeaderProps>;
		SyntaxHighlighter: ComponentType<SyntaxHighlighterProps>;
	};
	componentsByLanguage?: ComponentsByLanguage | undefined;
};

let CodeBlockOverride: FC<CodeOverrideProps> = (
	{
		node,
		components: {
			Pre,
			Code,
			SyntaxHighlighter: FallbackSyntaxHighlighter,
			CodeHeader: FallbackCodeHeader,
		},
		componentsByLanguage = {},
		children,
		...codeProps
	},
) => {
	let preProps = useContext(PreContext)!;
	let renderContext = { Pre, Code, preProps, codeProps };
	let language = parseLanguageClass(codeProps.className);
	let SyntaxHighlighter: ComponentType<SyntaxHighlighterProps> =
		componentsByLanguage[language]?.SyntaxHighlighter ?? FallbackSyntaxHighlighter;
	let CodeHeader: ComponentType<CodeHeaderProps> = componentsByLanguage[language]?.CodeHeader
		?? FallbackCodeHeader;

	if (children != null && typeof children !== "string") {
		return (
			<CodeRenderContext.Provider value={renderContext}>
				<CodeHeader code={extractCode(children)} language={language} node={node} />
				<DefaultCodeBlockContent
					code={children}
					components={{ Pre: WrappedPre, Code: WrappedCode }}
					node={node}
				/>
			</CodeRenderContext.Provider>
		);
	}

	return (
		<CodeRenderContext.Provider value={renderContext}>
			<DefaultCodeBlock
				code={children ?? ""}
				components={{ Pre: WrappedPre, Code: WrappedCode, SyntaxHighlighter, CodeHeader }}
				language={language}
				node={node}
			/>
		</CodeRenderContext.Provider>
	);
};

let CodeOverrideImpl: FC<CodeOverrideProps> = (
	{ node, components, componentsByLanguage, ...props },
) => {
	let isCodeBlock = useIsMarkdownCodeBlock();
	if (!isCodeBlock) return <components.Code {...props} />;
	return (
		<CodeBlockOverride
			components={components}
			componentsByLanguage={componentsByLanguage}
			node={node}
			{...props}
		/>
	);
};

/**
 * Compared structurally: the prop is written as an object literal, so a fresh but equal map on
 * every render must not draw (and tokenize) every code block again while a message streams.
 */
export let compareComponentsByLanguage = (
	prev: Record<string, ComponentsByLanguage[string] | undefined> | undefined,
	next: Record<string, ComponentsByLanguage[string] | undefined> | undefined,
): boolean => {
	if (prev === next) return true;
	if (!prev || !next) return false;
	let prevKeys = Object.keys(prev);
	if (prevKeys.length !== Object.keys(next).length) return false;
	for (let key of prevKeys) {
		if (!Object.hasOwn(next, key)) return false;
		let prevEntry = prev[key];
		let nextEntry = next[key];
		if (prevEntry === nextEntry) continue;
		if (!prevEntry || !nextEntry) return false;
		if (
			prevEntry.SyntaxHighlighter !== nextEntry.SyntaxHighlighter
			|| prevEntry.CodeHeader !== nextEntry.CodeHeader
		) return false;
	}
	return true;
};

export let CodeOverride = memo(CodeOverrideImpl, (prev, next) =>
	prev.components === next.components
	&& compareComponentsByLanguage(prev.componentsByLanguage, next.componentsByLanguage)
	&& memoCompareNodes(prev, next));
