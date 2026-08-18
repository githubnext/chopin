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

import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { addComposerChild$, readOnly$, realmPlugin } from "@mdxeditor/editor";
import { useCellValue } from "@mdxeditor/gurx";

import { ChangeObserver } from "./changes-observer";
import { CommentLayer } from "./comment-layer";
import { QuestionnaireObserver } from "./questionnaires";
import { TableRails } from "./table/rails";
import { TableTouchToolbar } from "./table/touch-toolbar";
import { ThreadObserver } from "./threads";
import { Toolbar } from "./toolbar";
import { CalloutPlugin, EnterPlugin, PreviewPlugin, TabsPlugin } from "./widgets";
import { widgets$ } from "./widget-options";

import type { WidgetOptions } from "./widget-options";

export { widgets$ } from "./widget-options";
export type { WidgetOptions } from "./widget-options";

function TableTouchToolbarPlugin() {
	let [editor] = useLexicalComposerContext();
	let disabled = useCellValue(readOnly$);
	return <TableTouchToolbar disabled={disabled} editor={editor} />;
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
		// Also where `@lexical/table`'s own plugins are registered, which the
		// editor otherwise runs without.
		realm.pub(addComposerChild$, TableRails);
		realm.pub(addComposerChild$, TableTouchToolbarPlugin);
		realm.pub(addComposerChild$, Toolbar);
	},
	update(realm, params) {
		realm.pub(widgets$, params ?? {});
	},
});
