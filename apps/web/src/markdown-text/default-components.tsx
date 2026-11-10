/**
 * The default `aui-md-*` element set and the code header.
 *
 * Adapted from assistant-ui's elements/markdown-text.tsx (MIT) at f92028b4, blob e1d670e1 (see
 * THIRD_PARTY_NOTICES.md). The elements, their `aui-md-*` class names and the `CodeHeader` slot are
 * upstream's. Changed: upstream styles each element with Tailwind utility classes from shadcn's
 * colour names; here every element carries only its class name, and `markdown-text.css` styles them
 * with Chopin's tokens. The copy button is Chopin's icon button and its icons.
 */

import { useEffect, useRef, useState } from "react";
import { CheckIcon, CopyIcon } from "@chopin/icons";

import { useIsMarkdownCodeBlock } from "./code-blocks";
import { memoizeMarkdownComponents } from "./memoization";

import type { ComponentProps, FC } from "react";
import type { CodeHeaderProps } from "./code-blocks";

let cn = (...names: (string | undefined)[]) => names.filter(Boolean).join(" ");

/** How long the copy button shows its check after a successful copy, as upstream's does. */
const COPIED_MS = 3000;

/**
 * A fenced block's header: its language and a button that copies its code. The write starts in the
 * click itself, so the clipboard keeps the user's gesture.
 */
export let CopyCodeHeader: FC<CodeHeaderProps> = ({ language, code }) => {
	let [copied, setCopied] = useState(false);
	let timer = useRef<ReturnType<typeof setTimeout>>(undefined);
	useEffect(() => () => clearTimeout(timer.current), []);
	let copy = () => {
		if (!code || copied) return;
		navigator.clipboard.writeText(code).then(() => {
			setCopied(true);
			clearTimeout(timer.current);
			timer.current = setTimeout(() => setCopied(false), COPIED_MS);
		}, () => {});
	};
	return (
		<div className="aui-code-header-root">
			<span className="aui-code-header-language">{language}</span>
			<button
				aria-label={copied ? "Copied" : "Copy code"}
				className="btn btn-icon-xs btn-ghost"
				data-copied={copied ? "" : undefined}
				onClick={copy}
				type="button"
			>
				{copied ? <CheckIcon aria-hidden="true" size={12} /> : <CopyIcon />}
			</button>
		</div>
	);
};

export let defaultComponents = memoizeMarkdownComponents({
	h1: ({ className, ...props }: ComponentProps<"h1">) => (
		<h1 className={cn("aui-md-h1", className)} {...props} />
	),
	h2: ({ className, ...props }: ComponentProps<"h2">) => (
		<h2 className={cn("aui-md-h2", className)} {...props} />
	),
	h3: ({ className, ...props }: ComponentProps<"h3">) => (
		<h3 className={cn("aui-md-h3", className)} {...props} />
	),
	h4: ({ className, ...props }: ComponentProps<"h4">) => (
		<h4 className={cn("aui-md-h4", className)} {...props} />
	),
	h5: ({ className, ...props }: ComponentProps<"h5">) => (
		<h5 className={cn("aui-md-h5", className)} {...props} />
	),
	h6: ({ className, ...props }: ComponentProps<"h6">) => (
		<h6 className={cn("aui-md-h6", className)} {...props} />
	),
	p: ({ className, ...props }: ComponentProps<"p">) => (
		<p className={cn("aui-md-p", className)} {...props} />
	),
	a: ({ className, ...props }: ComponentProps<"a">) => (
		<a className={cn("aui-md-a", className)} {...props} />
	),
	blockquote: ({ className, ...props }: ComponentProps<"blockquote">) => (
		<blockquote className={cn("aui-md-blockquote", className)} {...props} />
	),
	ul: ({ className, ...props }: ComponentProps<"ul">) => (
		<ul className={cn("aui-md-ul", className)} {...props} />
	),
	ol: ({ className, ...props }: ComponentProps<"ol">) => (
		<ol className={cn("aui-md-ol", className)} {...props} />
	),
	hr: ({ className, ...props }: ComponentProps<"hr">) => (
		<hr className={cn("aui-md-hr", className)} {...props} />
	),
	table: ({ className, ...props }: ComponentProps<"table">) => (
		<div className="aui-md-table-wrapper">
			<table className={cn("aui-md-table", className)} {...props} />
		</div>
	),
	th: ({ className, ...props }: ComponentProps<"th">) => (
		<th className={cn("aui-md-th", className)} {...props} />
	),
	td: ({ className, ...props }: ComponentProps<"td">) => (
		<td className={cn("aui-md-td", className)} {...props} />
	),
	tr: ({ className, ...props }: ComponentProps<"tr">) => (
		<tr className={cn("aui-md-tr", className)} {...props} />
	),
	li: ({ className, ...props }: ComponentProps<"li">) => (
		<li className={cn("aui-md-li", className)} {...props} />
	),
	strong: ({ className, ...props }: ComponentProps<"strong">) => (
		<strong className={cn("aui-md-strong", className)} {...props} />
	),
	sup: ({ className, ...props }: ComponentProps<"sup">) => (
		<sup className={cn("aui-md-sup", className)} {...props} />
	),
	pre: ({ className, ...props }: ComponentProps<"pre">) => (
		<pre className={cn("aui-md-pre", className)} {...props} />
	),
	code: function Code({ className, ...props }: ComponentProps<"code">) {
		let isCodeBlock = useIsMarkdownCodeBlock();
		return (
			<code className={cn(isCodeBlock ? undefined : "aui-md-inline-code", className)} {...props} />
		);
	},
	CodeHeader: CopyCodeHeader,
});
