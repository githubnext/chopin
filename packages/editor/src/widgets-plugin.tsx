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

import { useEffect } from "react";
import { $getSelection, $isRangeSelection } from "lexical";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { addComposerChild$, realmPlugin } from "@mdxeditor/editor";

import { ChangeObserver } from "./changes-observer";
import { CommentLayer } from "./comment-layer";
import { QuestionnaireObserver } from "./questionnaires";
import { TableChrome } from "./table/chrome";
import { ThreadObserver } from "./threads";
import { Toolbar } from "./toolbar";
import {
	CalloutPlugin,
	EnterPlugin,
	PreviewPlugin,
	ResearchDeletionPlugin,
	TabsPlugin,
} from "./widgets";
import { widgets$ } from "./widget-options";

import type { WidgetOptions } from "./widget-options";

export { widgets$ } from "./widget-options";
export type { WidgetOptions } from "./widget-options";

function SafeClickableLinkPlugin() {
	let [editor] = useLexicalComposerContext();

	useEffect(() => {
		let follow = (event: MouseEvent) => {
			if (event.defaultPrevented || (event.button !== 0 && event.button !== 1)) return;
			let target = event.target;
			if (!(target instanceof Element)) return;
			let link = target.closest<HTMLAnchorElement>("a[href]");
			if (!link || link.hasAttribute("download")) return;
			let selecting = editor.read(() => {
				let selection = $getSelection();
				return $isRangeSelection(selection) && !selection.isCollapsed();
			});
			if (selecting) {
				event.preventDefault();
				return;
			}
			event.preventDefault();
			event.stopPropagation();
			window.open(link.href, "_blank", "noopener,noreferrer");
		};
		let middle = (event: MouseEvent) => {
			if (event.button === 1) follow(event);
		};
		return editor.registerRootListener((current, previous) => {
			previous?.removeEventListener("click", follow);
			previous?.removeEventListener("mouseup", middle);
			current?.addEventListener("click", follow);
			current?.addEventListener("mouseup", middle);
		});
	}, [editor]);

	return null;
}

export const widgetsPlugin = realmPlugin<WidgetOptions>({
	init(realm, params) {
		realm.pub(widgets$, params ?? {});
		// The store is identity-stable and only ever observed, so unlike the
		// rest of the options it can be captured once.
		if (params?.questions) {
			let store = params.questions;
			realm.pub(addComposerChild$, () => <QuestionnaireObserver store={store} />);
		}
		if (params?.threads) {
			let store = params.threads;
			realm.pub(addComposerChild$, () => <ThreadObserver store={store} />);
			realm.pub(addComposerChild$, () => <CommentLayer store={store} />);
		}
		if (params?.changes) {
			let store = params.changes;
			realm.pub(addComposerChild$, () => <ChangeObserver store={store} />);
		}
		realm.pub(addComposerChild$, TabsPlugin);
		realm.pub(addComposerChild$, PreviewPlugin);
		realm.pub(addComposerChild$, CalloutPlugin);
		realm.pub(addComposerChild$, EnterPlugin);
		realm.pub(addComposerChild$, ResearchDeletionPlugin);
		// Link nodes live inside Lexical's contenteditable root, where a normal
		// browser click changes the selection instead of following the anchor.
		realm.pub(addComposerChild$, SafeClickableLinkPlugin);
		// Also where `@lexical/table`'s own plugins are registered, which the
		// editor otherwise runs without.
		realm.pub(addComposerChild$, TableChrome);
		realm.pub(addComposerChild$, Toolbar);
	},
	update(realm, params) {
		realm.pub(widgets$, params ?? {});
	},
});
