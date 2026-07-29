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

import { ChangeObserver } from "./changes-observer";
import { QuestionnaireObserver } from "./questionnaires";
import { ThreadObserver } from "./threads";
import { Toolbar } from "./toolbar";
import { CalloutPlugin, PreviewPlugin, TabsPlugin } from "./widgets";

import type { ChangeStore } from "./changes";
import type { QuestionnaireStore } from "./questionnaires";
import type { ThreadStore } from "./threads";

export type WidgetsOptions = {
	/** Watched from inside the editor; read from outside it. */
	questions?: QuestionnaireStore;
	/** The same arrangement for comments: observed here, rendered in the pane. */
	threads?: ThreadStore;
	/** Marks what the agent changed, which needs the document to place them. */
	changes?: ChangeStore;
};

/** Live host configuration. Read it; do not capture it. */
export const widgets$ = Cell<WidgetsOptions>({});

export const widgetsPlugin = realmPlugin<WidgetsOptions>({
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
		}
		if (params?.changes) {
			let store = params.changes;
			realm.pub(addComposerChild$, () => <ChangeObserver store={store} />);
		}
		realm.pub(addComposerChild$, TabsPlugin);
		realm.pub(addComposerChild$, PreviewPlugin);
		realm.pub(addComposerChild$, CalloutPlugin);
		realm.pub(addComposerChild$, Toolbar);
	},
	update(realm, params) {
		realm.pub(widgets$, params ?? {});
	},
});
