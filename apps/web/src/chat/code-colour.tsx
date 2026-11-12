/**
 * A fenced block in a Chat message, coloured by the language its fence names, as Slack's are: with
 * the document's own highlighter (`@chopin/editor/code-tokens`), which loads with the first block
 * that names a language and never before. A block nobody named, or named as plain text, stays as
 * written. Each token is a span carrying its role, which `markdown.css` colours with Chopin's tokens,
 * so the code's text, its selection and its copy are the code and nothing else.
 */

import { Fragment, useEffect, useRef, useState } from "react";
import { colour, colourable, loadedTokenizer, loadTokenizer } from "@chopin/editor/code-tokens";

import type { Coloured, Tokenize } from "@chopin/editor/code-tokens";
import type { SyntaxHighlighterProps } from "./assistant-ui/markdown-primitive";

/** The tokenizer of a fence's language, once it has loaded, or nothing while it loads or for plain text. */
function useTokenizer(language: string): Tokenize | undefined {
	let wanted = colourable(language) ? language.toLowerCase() : "";
	let [loaded, setLoaded] = useState(() => ({
		language: wanted,
		tokenize: wanted ? loadedTokenizer(wanted) : undefined,
	}));
	let current = loaded.language === wanted ? loaded.tokenize : undefined;
	useEffect(() => {
		if (!wanted || current) return;
		let live = true;
		loadTokenizer(wanted).then(
			tokenize => {
				if (live && tokenize) setLoaded({ language: wanted, tokenize });
			},
			// A grammar or the highlighter that cannot load leaves the block as written.
			() => {},
		);
		return () => {
			live = false;
		};
	}, [wanted, current]);
	return current ?? (wanted ? loadedTokenizer(wanted) : undefined);
}

export function ChatCodeColour(
	{ code, components: { Code, Pre }, language }: Omit<SyntaxHighlighterProps, "node">,
) {
	let tokenize = useTokenizer(language);
	// A streamed block grows at its end: what is held is coloured once, and only what it gains is read.
	let held = useRef<Coloured>(undefined);
	let lines = undefined;
	if (tokenize) {
		let coloured = colour(tokenize, code, held.current);
		held.current = coloured.held;
		lines = coloured.lines;
	}
	// The block's `pre` is memoised on its Markdown node, which colouring does not change, so it is
	// given none and drawn again with its lines.
	return (
		<Pre node={undefined}>
			<Code>
				{lines
					? lines.map((line, index) => (
						<Fragment key={index}>
							{index > 0 && "\n"}
							{line.map((token, at) =>
								token.role
									? <span data-token={token.role} key={at}>{token.text}</span>
									: <Fragment key={at}>{token.text}</Fragment>
							)}
						</Fragment>
					))
					: code}
			</Code>
		</Pre>
	);
}
