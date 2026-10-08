import { useEffect } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $createParagraphNode, $getRoot, $isParagraphNode } from "lexical";

import { captureResearchPosition } from "./research";

import type { Binding } from "@lexical/yjs";
import type { RelativePosition } from "yjs";
import type { ResearchDraftStore } from "../research-draft";
import type { ResearchLauncher } from "../research-launcher";

/** Attach the host's launcher to this editor: an empty last paragraph, then the usual draft. */
export function ResearchLaunchRegistration(
	{ binding, disabled, drafts, launcher }: {
		binding?: Binding;
		disabled?: boolean;
		drafts: ResearchDraftStore;
		launcher: ResearchLauncher;
	},
) {
	let [editor] = useLexicalComposerContext();
	useEffect(() =>
		launcher.attach({
			available: () => !disabled && !!binding && drafts.canOpen(),
			open: brief => {
				if (disabled || !binding || !drafts.canOpen()) return false;
				let key: string | undefined;
				editor.update(() => {
					let root = $getRoot();
					let last = root.getLastChild();
					let target = $isParagraphNode(last) && last.getTextContentSize() === 0
						? last
						: $createParagraphNode();
					if (target !== last) root.append(target);
					target.select();
					key = target.getKey();
				}, { discrete: true });
				let element = key ? editor.getElementByKey(key) : null;
				if (!element) return false;
				// Centre it so the composer below the paragraph has room to show.
				element.scrollIntoView({ block: "center" });
				let position: RelativePosition | undefined;
				editor.getEditorState().read(() => {
					position = captureResearchPosition(binding);
				});
				if (!drafts.open(element.getBoundingClientRect(), position)) return false;
				if (brief) drafts.change(brief);
				return true;
			},
		}), [binding, disabled, drafts, editor, launcher]);
	return null;
}
