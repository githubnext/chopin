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
	h1: (props: ComponentProps<"h1">) => <h1 className="aui-md-h1" {...props} />,
	h2: (props: ComponentProps<"h2">) => <h2 className="aui-md-h2" {...props} />,
	h3: (props: ComponentProps<"h3">) => <h3 className="aui-md-h3" {...props} />,
	h4: (props: ComponentProps<"h4">) => <h4 className="aui-md-h4" {...props} />,
	h5: (props: ComponentProps<"h5">) => <h5 className="aui-md-h5" {...props} />,
	h6: (props: ComponentProps<"h6">) => <h6 className="aui-md-h6" {...props} />,
	p: (props: ComponentProps<"p">) => <p className="aui-md-p" {...props} />,
	a: (props: ComponentProps<"a">) => <a className="aui-md-a" {...props} />,
	blockquote: (props: ComponentProps<"blockquote">) => (
		<blockquote className="aui-md-blockquote" {...props} />
	),
	ul: ({ className, ...props }: ComponentProps<"ul">) => (
		<ul className={cn("aui-md-ul", className)} {...props} />
	),
	ol: ({ className, ...props }: ComponentProps<"ol">) => (
		<ol className={cn("aui-md-ol", className)} {...props} />
	),
	hr: (props: ComponentProps<"hr">) => <hr className="aui-md-hr" {...props} />,
	table: (props: ComponentProps<"table">) => (
		<div className="aui-md-table-wrapper">
			<table className="aui-md-table" {...props} />
		</div>
	),
	th: (props: ComponentProps<"th">) => <th className="aui-md-th" {...props} />,
	td: (props: ComponentProps<"td">) => <td className="aui-md-td" {...props} />,
	tr: (props: ComponentProps<"tr">) => <tr className="aui-md-tr" {...props} />,
	li: ({ className, ...props }: ComponentProps<"li">) => (
		<li className={cn("aui-md-li", className)} {...props} />
	),
	strong: (props: ComponentProps<"strong">) => <strong className="aui-md-strong" {...props} />,
	sup: (props: ComponentProps<"sup">) => <sup className="aui-md-sup" {...props} />,
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
