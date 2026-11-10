/**
 * The default `aui-md-*` element set and the code header.
 *
 * Adapted from assistant-ui's elements/markdown-text.tsx (MIT) at f92028b4, blob e1d670e1 (see
 * THIRD_PARTY_NOTICES.md). The elements, their `aui-md-*` class names and the `CodeHeader` slot are
 * upstream's. Changed: upstream styles each element with Tailwind utility classes from shadcn's
 * colour names; here every element carries only its class name, and `markdown-text.css` styles them
 * with Chopin's tokens. The copy button is Chopin's icon button and its icons.
 */

import { memo, useEffect, useRef, useState } from "react";
import { CheckIcon, CopyIcon, WarningIcon } from "@chopin/icons";

import { useIsMarkdownCodeBlock } from "./code-blocks";
import { memoCompareNodes } from "./memoization";

import type { ElementType, FC } from "react";
import type { CodeHeaderProps } from "./code-blocks";
import type { HastElement } from "./memoization";

let cn = (...names: (string | undefined)[]) => names.filter(Boolean).join(" ");

/** How long the copy button shows its check after a successful copy, as upstream's does. */
const COPIED_MS = 3000;

/**
 * A fenced block's header: its language and a button that copies its code. The write starts in the
 * click itself, so the clipboard keeps the user's gesture. A page with no clipboard (an insecure
 * origin) and a write the browser refuses both say so in the button's name and with a warning glyph
 * in the danger role, since a touch screen shows no tooltip, for as long as a copy says it worked,
 * and the button then offers the copy again.
 */
export let CopyCodeHeader: FC<CodeHeaderProps> = ({ language, code }) => {
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
			let written = navigator.clipboard.writeText(code);
			written.then(() => done("copied"), () => done("failed"));
		} catch {
			done("failed");
		}
	};
	return (
		<div className="aui-code-header-root">
			<span className="aui-code-header-language">{language}</span>
			<button
				aria-label={outcome === "copied"
					? "Copied"
					: outcome === "failed"
					? "Couldn't copy"
					: "Copy code"}
				className="btn btn-icon-xs btn-ghost"
				data-copied={outcome === "copied" ? "" : undefined}
				data-failed={outcome === "failed" ? "" : undefined}
				onClick={copy}
				type="button"
			>
				{outcome === "copied"
					? <CheckIcon aria-hidden="true" size={12} />
					: outcome === "failed"
					? <WarningIcon aria-hidden="true" className="icon-danger" size={12} />
					: <CopyIcon />}
			</button>
		</div>
	);
};

type HastProps = { node?: HastElement; className?: string };

/**
 * One default element: its tag, its `aui-md-*` class joined to the class it is given, and the
 * properties react-markdown computed. It is memoized on its hast node itself, as
 * `memoizeMarkdownComponents` would, but without a second component under the memo: a transcript
 * draws thousands of these, and a layer per element is a fibre per element.
 */
let element = (Tag: ElementType, own: string) =>
	memo(
		({ node: _node, className, ...props }: HastProps) => (
			<Tag className={cn(own, className)} {...props} />
		),
		memoCompareNodes,
	);

export let defaultComponents = {
	h1: element("h1", "aui-md-h1"),
	h2: element("h2", "aui-md-h2"),
	h3: element("h3", "aui-md-h3"),
	h4: element("h4", "aui-md-h4"),
	h5: element("h5", "aui-md-h5"),
	h6: element("h6", "aui-md-h6"),
	p: element("p", "aui-md-p"),
	a: element("a", "aui-md-a"),
	blockquote: element("blockquote", "aui-md-blockquote"),
	ul: element("ul", "aui-md-ul"),
	ol: element("ol", "aui-md-ol"),
	hr: element("hr", "aui-md-hr"),
	table: memo(
		({ node: _node, className, ...props }: HastProps) => (
			<div className="aui-md-table-wrapper">
				<table className={cn("aui-md-table", className)} {...props} />
			</div>
		),
		memoCompareNodes,
	),
	th: element("th", "aui-md-th"),
	td: element("td", "aui-md-td"),
	tr: element("tr", "aui-md-tr"),
	li: element("li", "aui-md-li"),
	strong: element("strong", "aui-md-strong"),
	sup: element("sup", "aui-md-sup"),
	pre: element("pre", "aui-md-pre"),
	code: memo(function Code({ node: _node, className, ...props }: HastProps) {
		let isCodeBlock = useIsMarkdownCodeBlock();
		return (
			<code className={cn(isCodeBlock ? undefined : "aui-md-inline-code", className)} {...props} />
		);
	}, memoCompareNodes),
	CodeHeader: memo(CopyCodeHeader, memoCompareNodes),
};
