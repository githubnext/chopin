import { fromMarkdown } from "mdast-util-from-markdown";
import { toString as plainText } from "mdast-util-to-string";

import { inlineSource } from "./markdown";

/**
 * The text `InlineMarkdown` shows for `source`, parsed as it parses it, with single spaces: what
 * an accessible name built around it should read. Raw HTML and images show nothing.
 */
export function inlineText(source: string): string {
	return plainText(fromMarkdown(inlineSource(source)), {
		includeHtml: false,
		includeImageAlt: false,
	})
		.replace(/\s+/g, " ").trim();
}
