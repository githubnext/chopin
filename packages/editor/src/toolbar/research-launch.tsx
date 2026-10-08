import { useEffect } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $createParagraphNode, $getRoot, $isParagraphNode } from "lexical";

import { captureResearchPosition } from "./research";

import type { Binding } from "@lexical/yjs";
import type { RelativePosition } from "yjs";
import type { ResearchDraftStore } from "../research-draft";
import type { ResearchLauncher, ResearchLaunchResult } from "../research-launcher";

const DRAFT_INPUT = '[role="region"][aria-label="Research question"] textarea';

/** Once the composer takes focus, put the caret after the prefilled brief. */
function caretToEndOnFocus(): void {
	let done = () => {
		document.removeEventListener("focusin", focused, true);
		clearTimeout(timer);
	};
	let focused = (event: FocusEvent) => {
		let target = event.target;
		if (!(target instanceof HTMLTextAreaElement) || !target.matches(DRAFT_INPUT)) return;
		done();
		target.setSelectionRange(target.value.length, target.value.length);
		target.scrollTop = target.scrollHeight;
	};
	let timer = setTimeout(done, 1_000);
	document.addEventListener("focusin", focused, true);
}

/** Attach the host's launcher to this editor: an empty last paragraph, then the usual draft. */
export function ResearchLaunchRegistration(
	{ binding, canEdit, connected, disabled, drafts, launcher }: {
		binding?: Binding;
		canEdit?: boolean;
		connected?: boolean;
		disabled?: boolean;
		drafts: ResearchDraftStore;
		launcher: ResearchLauncher;
	},
) {
	let [editor] = useLexicalComposerContext();
	useEffect(() => {
		let check = (): ResearchLaunchResult => {
			if (canEdit === false) return { ok: false, reason: "read-only" };
			if (!connected || !binding || disabled) return { ok: false, reason: "disconnected" };
			if (!drafts.canOpen()) return { ok: false, reason: "drafting" };
			return { ok: true };
		};
		return launcher.attach({
			check,
			open: brief => {
				let checked = check();
				if (!checked.ok || !binding) return checked;
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
				if (!element) return { ok: false, reason: "unavailable" };
				// Centre it so the composer below the paragraph has room to show.
				element.scrollIntoView({ block: "center" });
				let position: RelativePosition | undefined;
				editor.getEditorState().read(() => {
					position = captureResearchPosition(binding);
				});
				if (brief) caretToEndOnFocus();
				if (!drafts.open(element.getBoundingClientRect(), position)) {
					return { ok: false, reason: "drafting" };
				}
				if (brief) drafts.change(brief);
				return { ok: true };
			},
			reveal: () => {
				let input = editor.getRootElement()?.closest(".mdxeditor")?.querySelector<HTMLElement>(
					DRAFT_INPUT,
				);
				input?.focus();
				return !!input;
			},
		});
	}, [binding, canEdit, connected, disabled, drafts, editor, launcher]);
	return null;
}
