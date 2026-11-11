/**
 * Props-driven Markdown primitive for the copied `@assistant-ui/markdown-text` registry item.
 *
 * Upstream's `markdown-text` has no standalone (`elements-markdown-text`) form: it imports
 * `MarkdownTextPrimitive` from `@assistant-ui/react-markdown`, which reads the text and status from
 * `@assistant-ui/react`'s message-part runtime. Chopin's Chat is collaborative and Yjs-backed and
 * installs no `@assistant-ui/*` runtime package, so `tsconfig.json` and `vite.config.ts` point both
 * module specifiers here, where `text` and `status` arrive as props.
 */

import {
	createContext,
	isValidElement,
	memo,
	useContext,
	useDeferredValue,
	useMemo,
	useRef,
} from "react";
import ReactMarkdown from "react-markdown";

import type {
	ComponentProps,
	ComponentPropsWithoutRef,
	ComponentType,
	ElementType,
	FC,
	ReactNode,
} from "react";
import type { ExtraProps, Options } from "react-markdown";

export type HastElement = NonNullable<ExtraProps["node"]>;

export type MarkdownTextStatus = "running" | "complete" | "incomplete";

export type TextMessagePartProps = {
	text: string;
	status?: MarkdownTextStatus | { readonly type: MarkdownTextStatus } | undefined;
};

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

type MemoizableComponents =
	& {
		[Key in Extract<ElementType, string>]?: ComponentType<ComponentProps<Key>>;
	}
	& {
		SyntaxHighlighter?: ComponentType<Omit<SyntaxHighlighterProps, "node">> | undefined;
		CodeHeader?: ComponentType<Omit<CodeHeaderProps, "node">> | undefined;
	};

export type MarkdownTextPrimitiveProps =
	& Omit<Options, "children" | "components">
	& {
		text?: string | undefined;
		status?: MarkdownTextStatus | { readonly type: MarkdownTextStatus } | undefined;
		"data-slot"?: string | undefined;
		className?: string | undefined;
		containerProps?: (Record<string, string | undefined> & { className?: string }) | undefined;
		containerComponent?: ElementType | undefined;
		lead?: ReactNode;
		components?:
			| (NonNullable<Options["components"]> & {
				SyntaxHighlighter?: ComponentType<SyntaxHighlighterProps> | undefined;
				CodeHeader?: ComponentType<CodeHeaderProps> | undefined;
			})
			| undefined;
		componentsByLanguage?: ComponentsByLanguage | undefined;
		defer?: boolean | undefined;
	};

function sameTreeValue(
	before: unknown,
	after: unknown,
	depth = 0,
	skipOffsets = false,
): boolean {
	if (Object.is(before, after)) return true;
	if (depth >= 100) return false;
	if (typeof before !== "object" || before === null) return false;
	if (typeof after !== "object" || after === null) return false;
	if (Array.isArray(before)) {
		if (!Array.isArray(after) || before.length !== after.length) return false;
		for (let index = 0; index < before.length; index++) {
			if (!sameTreeValue(before[index], after[index], depth + 1)) return false;
		}
		return true;
	}
	if (Array.isArray(after)) return false;
	let beforeProto = Object.getPrototypeOf(before);
	let afterProto = Object.getPrototypeOf(after);
	if (beforeProto !== Object.prototype && beforeProto !== null) return false;
	if (afterProto !== Object.prototype && afterProto !== null) return false;

	let left = before as Record<string, unknown>;
	let right = after as Record<string, unknown>;
	let leftCount = 0;
	for (let key in left) {
		if (!Object.hasOwn(left, key)) continue;
		if (skipOffsets && (key === "position" || key === "data")) continue;
		if (
			!Object.prototype.propertyIsEnumerable.call(right, key)
			|| !sameTreeValue(left[key], right[key], depth + 1)
		) return false;
		leftCount++;
	}
	let rightCount = 0;
	for (let key in right) {
		if (!Object.hasOwn(right, key)) continue;
		if (skipOffsets && (key === "position" || key === "data")) continue;
		rightCount++;
	}
	return leftCount === rightCount;
}

export function sameHastNode(
	before: { node?: HastElement | undefined },
	after: { node?: HastElement | undefined },
): boolean {
	if (!before.node || !after.node) return false;
	if (before.node === after.node) return true;
	return sameTreeValue(before.node.properties, after.node.properties, 0, true)
		&& sameTreeValue(before.node.children, after.node.children);
}

function wrapWithoutNode(Component: ComponentType) {
	return memo(
		({ node: _node, ...props }: { node?: HastElement }) => <Component {...props} />,
		sameHastNode,
	);
}

type MemoizedComponents<T extends MemoizableComponents> = {
	[K in keyof T]: T[K] extends ComponentType<infer P> | undefined
		? ComponentType<P & { node?: HastElement | undefined }>
		: T[K];
};

export function memoizeMarkdownComponents<T extends MemoizableComponents = MemoizableComponents>(
	components: T = {} as T,
): MemoizedComponents<T> {
	return Object.fromEntries(
		Object.entries(components ?? {}).map(([key, value]) => [
			key,
			value ? wrapWithoutNode(value as ComponentType) : value,
		]),
	) as MemoizedComponents<T>;
}

let PrePropsContext = createContext<
	Omit<ComponentPropsWithoutRef<PreComponent>, "children"> | null
>(
	null,
);

export let useIsMarkdownCodeBlock = () => useContext(PrePropsContext) !== null;

type CodeBlockSlots = {
	Pre: PreComponent;
	Code: CodeComponent;
	CodeHeader: ComponentType<CodeHeaderProps>;
	SyntaxHighlighter: ComponentType<SyntaxHighlighterProps>;
};

type CodeBlockConfig = {
	slots: CodeBlockSlots;
	componentsByLanguage?: ComponentsByLanguage | undefined;
};

let CodeBlockConfigContext = createContext<CodeBlockConfig | null>(null);

type BoundFenceValue = {
	Pre: PreComponent;
	Code: CodeComponent;
	preProps: Omit<ComponentPropsWithoutRef<PreComponent>, "children">;
	codeProps: ComponentPropsWithoutRef<CodeComponent>;
};

let BoundFenceContext = createContext<BoundFenceValue | null>(null);

let joinClasses = (...names: (string | undefined)[]) => names.filter(Boolean).join(" ");

function BoundPre({ className, ...props }: ComponentPropsWithoutRef<PreComponent>) {
	let { Pre, preProps } = useContext(BoundFenceContext)!;
	return (
		<Pre
			{...preProps}
			{...props}
			className={joinClasses(preProps.className, className)}
		/>
	);
}

function BoundCode({ className, ...props }: ComponentPropsWithoutRef<CodeComponent>) {
	let { Code, codeProps } = useContext(BoundFenceContext)!;
	return (
		<Code
			{...codeProps}
			{...props}
			className={joinClasses(codeProps.className, className)}
		/>
	);
}

let BOUND_FENCE_COMPONENTS = { Pre: BoundPre, Code: BoundCode };

let PlainPre: PreComponent = ({ node: _node, ...props }) => <pre {...props} />;
let PlainCode: CodeComponent = ({ node: _node, ...props }) => <code {...props} />;
let EmptyCodeHeader: ComponentType<CodeHeaderProps> = () => null;
let PlainSyntaxHighlighter: ComponentType<SyntaxHighlighterProps> = (
	{ code, components: { Pre, Code }, node },
) => (
	<Pre>
		<Code node={node}>{code}</Code>
	</Pre>
);

function textFromChildren(children: unknown): string {
	if (typeof children === "string") return children;
	if (Array.isArray(children)) {
		let out = "";
		for (let item of children) out += textFromChildren(item);
		return out;
	}
	if (isValidElement<{ children?: unknown }>(children)) {
		return textFromChildren(children.props.children);
	}
	return "";
}

function fenceLanguage(className: string | undefined): string {
	return /(?:^|\s)language-(\S+)/.exec(className ?? "")?.[1] ?? "";
}

let FencePre = memo(
	function FencePre(
		{ children, fallbackPre: FallbackPre, ...rest }:
			& ComponentPropsWithoutRef<PreComponent>
			& { fallbackPre: PreComponent },
	) {
		let wrapsCode = rest.node?.children.some(
			child => child.type === "element" && child.tagName === "code",
		) ?? true;
		if (!wrapsCode) return <FallbackPre {...rest}>{children}</FallbackPre>;
		return <PrePropsContext.Provider value={rest}>{children}</PrePropsContext.Provider>;
	},
	(prev, next) => prev.fallbackPre === next.fallbackPre && sameHastNode(prev, next),
);

function sameLanguageMap(
	before: ComponentsByLanguage | undefined,
	after: ComponentsByLanguage | undefined,
): boolean {
	if (before === after) return true;
	if (!before || !after) return false;
	let keys = Object.keys(before);
	if (keys.length !== Object.keys(after).length) return false;
	for (let key of keys) {
		if (!Object.hasOwn(after, key)) return false;
		let left = before[key];
		let right = after[key];
		if (left === right) continue;
		if (!left || !right) return false;
		if (
			left.CodeHeader !== right.CodeHeader || left.SyntaxHighlighter !== right.SyntaxHighlighter
		) {
			return false;
		}
	}
	return true;
}

let FenceCode = memo(
	function FenceCode(
		{ children, config, node, ...codeProps }:
			& ComponentPropsWithoutRef<CodeComponent>
			& { config: CodeBlockConfig },
	) {
		let preProps = useContext(PrePropsContext);
		if (!preProps) return <config.slots.Code {...codeProps}>{children}</config.slots.Code>;

		let language = fenceLanguage(codeProps.className);
		let byLanguage = config.componentsByLanguage?.[language];
		let Header = byLanguage?.CodeHeader ?? config.slots.CodeHeader;
		let Highlighter = byLanguage?.SyntaxHighlighter ?? config.slots.SyntaxHighlighter;
		let bound: BoundFenceValue = {
			Pre: config.slots.Pre,
			Code: config.slots.Code,
			preProps,
			codeProps,
		};

		if (children != null && typeof children !== "string") {
			return (
				<BoundFenceContext.Provider value={bound}>
					<Header code={textFromChildren(children)} language={language} node={node} />
					<BoundPre>
						<BoundCode node={node}>{children}</BoundCode>
					</BoundPre>
				</BoundFenceContext.Provider>
			);
		}

		return (
			<BoundFenceContext.Provider value={bound}>
				<Header code={children ?? ""} language={language} node={node} />
				<Highlighter
					code={children ?? ""}
					components={BOUND_FENCE_COMPONENTS}
					language={language}
					node={node}
				/>
			</BoundFenceContext.Provider>
		);
	},
	(prev, next) =>
		prev.config.slots === next.config.slots
		&& sameLanguageMap(prev.config.componentsByLanguage, next.config.componentsByLanguage)
		&& sameHastNode(prev, next),
);

let PreDispatch: FC<ComponentProps<PreComponent>> = props => {
	let { slots } = useContext(CodeBlockConfigContext)!;
	return <FencePre {...props} fallbackPre={slots.Pre} />;
};

let CodeDispatch: FC<ComponentProps<CodeComponent>> = props => {
	let config = useContext(CodeBlockConfigContext)!;
	return <FenceCode {...props} config={config} />;
};

type ParsedMarkdownProps = Omit<Options, "children"> & { text: string };

let ParsedMarkdown: FC<ParsedMarkdownProps> = memo(
	({ text, ...options }) => <ReactMarkdown {...options}>{text}</ReactMarkdown>,
);
ParsedMarkdown.displayName = "ParsedMarkdown";

let DeferredParsedMarkdown: FC<ParsedMarkdownProps> = ({ text, ...options }) => {
	let deferred = useDeferredValue(text);
	return <ParsedMarkdown text={deferred} {...options} />;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameToDepth(left: unknown, right: unknown, depth = 1): boolean {
	if (Object.is(left, right)) return true;
	if (depth <= 0) return false;
	if (Array.isArray(left) && Array.isArray(right)) {
		if (left.length !== right.length) return false;
		for (let index = 0; index < left.length; index++) {
			if (!sameToDepth(left[index], right[index], depth - 1)) return false;
		}
		return true;
	}
	if (isRecord(left) && isRecord(right)) {
		let keys = Object.keys(left);
		return keys.length === Object.keys(right).length
			&& keys.every(key =>
				Object.hasOwn(right, key) && sameToDepth(left[key], right[key], depth - 1)
			);
	}
	return false;
}

function useStable<T>(value: T, depth: number): T {
	let held = useRef(value);
	if (!sameToDepth(value, held.current, depth)) held.current = value;
	return held.current;
}

let readOption = (source: object, key: string) => (source as Record<string, unknown>)[key];

function useStableOptions<T extends object>(options: T): T {
	let held = useRef(options);
	let keys = Object.keys(options);
	let previousKeys = Object.keys(held.current);
	let unchanged = keys.length === previousKeys.length
		&& keys.every(key =>
			Object.hasOwn(held.current, key)
			&& sameToDepth(readOption(options, key), readOption(held.current, key))
		);
	if (!unchanged) held.current = options;
	return held.current;
}

export let MarkdownTextPrimitive: FC<MarkdownTextPrimitiveProps> = (
	{
		"data-slot": dataSlot,
		className,
		components: userComponents,
		componentsByLanguage,
		containerComponent: Container = "div",
		containerProps,
		defer = false,
		lead,
		status,
		text = "",
		...options
	},
) => {
	let {
		pre = PlainPre,
		code = PlainCode,
		CodeHeader = EmptyCodeHeader,
		SyntaxHighlighter = PlainSyntaxHighlighter,
	} = userComponents ?? {};

	let slots = useMemo(
		() => ({
			Pre: pre as PreComponent,
			Code: code as CodeComponent,
			CodeHeader,
			SyntaxHighlighter,
		}),
		[pre, code, CodeHeader, SyntaxHighlighter],
	);

	let config = useStable(
		useMemo(() => ({ slots, componentsByLanguage }), [slots, componentsByLanguage]),
		3,
	);

	let components: Options["components"] = useStableOptions(
		useMemo(() => {
			let { pre: _pre, code: _code, CodeHeader: _h, SyntaxHighlighter: _s, ...rest } =
				userComponents ?? {};
			return { ...rest, pre: PreDispatch, code: CodeDispatch };
		}, [userComponents]),
	);

	let stableOptions = useStableOptions(options);
	let Renderer = defer ? DeferredParsedMarkdown : ParsedMarkdown;
	let statusValue = typeof status === "string" ? status : status?.type ?? "complete";
	let { className: containerClass, ...attributes } = containerProps ?? {};
	let rootClass = joinClasses(
		className && className !== "aui-md" ? className : undefined,
		"aui-md",
		containerClass,
	);

	return (
		<Container data-slot={dataSlot} data-status={statusValue} {...attributes} className={rootClass}>
			{lead}
			<CodeBlockConfigContext.Provider value={config}>
				<Renderer components={components} text={text} {...stableOptions} />
			</CodeBlockConfigContext.Provider>
		</Container>
	);
};
