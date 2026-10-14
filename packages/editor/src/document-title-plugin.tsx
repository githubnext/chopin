import { useEffect } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { useCellValue } from "@mdxeditor/gurx";
import { registerDocumentTitle } from "./document-title";
import { widgets$ } from "./widget-options";

export function DocumentTitlePlugin() {
	let [editor] = useLexicalComposerContext();
	let { connected, synced, canEdit } = useCellValue(widgets$);
	useEffect(() => {
		if (!synced) return;
		return registerDocumentTitle(editor, !!connected && !!canEdit);
	}, [editor, connected, synced, canEdit]);
	return null;
}
