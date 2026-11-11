import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { defaultComponents } from "@/components/assistant-ui/elements/markdown-text";

import type { ComponentType } from "react";

type DefaultTag = Exclude<keyof typeof defaultComponents, "CodeHeader">;

/** The exact HTML-escaped `class` attribute a copied `defaultComponents` element emits. */
export function markdownClass(tag: DefaultTag): string {
	let markup = renderToStaticMarkup(createElement(defaultComponents[tag] as ComponentType));
	let found = /^<[a-z0-9]+ class="([^"]+)"/.exec(markup)?.[1];
	if (!found) throw new Error(`defaultComponents.${tag} rendered no class: ${markup}`);
	return found;
}
