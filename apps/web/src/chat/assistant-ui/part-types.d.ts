/**
 * The standalone prop types the copied `image.tsx` element imports as types. Chopin uses none of
 * assistant-ui's runtime and installs no `@assistant-ui/*` package (see docs/assistant-ui.md):
 * `tsconfig.json` points `@assistant-ui/react` at the Markdown seam, which this file augments.
 */
import type { ComponentType } from "react";

declare module "@assistant-ui/react" {
	export type ImageMessagePartStatus =
		| { readonly type: "running" }
		| { readonly type: "complete" }
		| { readonly type: "incomplete"; readonly reason?: string }
		| { readonly type: "requires-action"; readonly reason?: string };

	export type ImageMessagePart = {
		readonly type: "image";
		readonly image: string;
		readonly filename?: string | undefined;
		readonly status?: ImageMessagePartStatus | undefined;
	};

	export type ImageMessagePartComponent = ComponentType<ImageMessagePart>;
}
