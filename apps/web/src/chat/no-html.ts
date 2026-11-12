/**
 * Chat and the Build view never draw HTML, so nothing in their Markdown is read as HTML either:
 * `Option<u64>`, `Vec<Result<T, E>>` and `<placeholder>` are the text they were written as. Left
 * on, CommonMark reads anything shaped like a tag (`<u64>`, `<not-a-tag>`) as raw HTML, which was
 * then dropped, and a line that starts with one swallows the lines under it, Markdown and all.
 * Turning the two HTML constructs off at the parser keeps every character and every other piece
 * of Markdown, and adds no way to draw HTML: the text is escaped like any other text.
 * Autolinks (`<https://example.com>`) are their own construct and still work.
 */

/** micromark's extension that turns its HTML constructs off. */
export const NO_HTML = { disable: { null: ["htmlFlow", "htmlText"] } };

type Plugin = (this: { data(): unknown }) => void;

/** The same, as a remark plugin for MarkdownText. */
export const noHtmlRemarkPlugin: Plugin = function() {
	let data = this.data() as { micromarkExtensions?: unknown[] };
	(data.micromarkExtensions ??= []).push(NO_HTML);
};
