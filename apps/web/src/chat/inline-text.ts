import { fromMarkdown } from "mdast-util-from-markdown";
import { toString as plainText } from "mdast-util-to-string";

import { inlineSource } from "./markdown";
import { NO_HTML } from "./no-html";

/**
 * The text `InlineMarkdown` shows for `source`, parsed as it parses it, with single spaces: what
 * an accessible name built around it should read. A `<` is text, as it is there; images show nothing.
 */
export function inlineText(source: string): string {
	return plainText(
		fromMarkdown(
			inlineSource(source),
			{ extensions: [NO_HTML] } as Parameters<typeof fromMarkdown>[1],
		),
		{
			includeImageAlt: false,
		},
	)
		.replace(/\s+/g, " ").trim();
}
