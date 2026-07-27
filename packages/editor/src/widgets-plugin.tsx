/**
 * Mounts widget chrome into the editor.
 *
 * Composer children run inside the Lexical context, which is what the tab strip
 * needs to read the document and portal into each node's chrome slot.
 *
 * Options reach those children through a cell rather than a closure. A realm is
 * built once, from the plugin array as it stood on the first render, so
 * anything captured in `init` is frozen at whatever it was before the document
 * had loaded. `update` runs on every render, and publishing from both is the
 * only way a later value arrives.
 */

import { addComposerChild$, realmPlugin } from "@mdxeditor/editor";
import { Cell } from "@mdxeditor/gurx";

import { Toolbar } from "./toolbar";
import { CalloutPlugin, PreviewPlugin, TabsPlugin } from "./widgets";

import type { ToolbarProps } from "./toolbar";

export type WidgetsOptions = ToolbarProps;

/** Live host configuration. Read it; do not capture it. */
export const widgets$ = Cell<WidgetsOptions>({});

export const widgetsPlugin = realmPlugin<WidgetsOptions>({
	init(realm, params) {
		realm.pub(widgets$, params ?? {});
		realm.pub(addComposerChild$, TabsPlugin);
		realm.pub(addComposerChild$, PreviewPlugin);
		realm.pub(addComposerChild$, CalloutPlugin);
		realm.pub(addComposerChild$, Toolbar);
	},
	update(realm, params) {
		realm.pub(widgets$, params ?? {});
	},
});
