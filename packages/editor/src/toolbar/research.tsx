import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $getAnchorAndFocusForUserState } from "@lexical/yjs";
import {
	$createRangeSelection,
	$getNodeByKey,
	$getSelection,
	$insertNodes,
	$isElementNode,
	$isRangeSelection,
	$isTextNode,
	$setSelection,
	COMMAND_PRIORITY_LOW,
	createCommand,
} from "lexical";
import { $createResearchNode, $isResearchNode } from "@chopin/dialect";
import * as Y from "yjs";

import { ResearchComposer } from "../widgets/research";
import { placeSurface } from "./placement";
import { editorSurfaceViewport, listenToEditorGeometry, SHELL } from "./surface";

import type { Binding } from "@lexical/yjs";
import type { LexicalEditor } from "lexical";
import type { ResearchDraftStore } from "../research-draft";
import type { ResearchStore } from "../widget-options";
import type { DOMRectLike, SurfacePlacement } from "./placement";

export type OpenResearch = {
	anchor: DOMRectLike;
	consume: () => boolean;
};

export const OPEN_RESEARCH_COMMAND = createCommand<OpenResearch>("OPEN_RESEARCH_COMMAND");

/** Capture a document-safe insertion point before an asynchronous request begins. */
export function captureResearchPosition(binding: Binding): Y.RelativePosition | undefined {
	let selection = $getSelection();
	if (!$isRangeSelection(selection) || !selection.isCollapsed()) return;
	let point = selection.anchor;
	let node = point.getNode();
	let collab = binding.collabNodeMap.get(point.key);
	if (!collab) return;

	let shared = collab.getSharedType();
	let offset = point.offset;
	if ($isTextNode(node)) {
		let parent = node.getParent();
		let parentCollab = parent && binding.collabNodeMap.get(parent.getKey());
		let currentOffset = collab.getOffset();
		if (!parentCollab || currentOffset < 0) return;
		shared = parentCollab.getSharedType();
		offset = currentOffset + 1 + point.offset;
	} else if ($isElementNode(node) && point.type === "element") {
		offset = 0;
		for (let child of node.getChildren().slice(0, point.offset)) {
			offset += $isTextNode(child) ? child.getTextContentSize() + 1 : 1;
		}
	}
	return Y.createRelativePositionFromTypeIndex(shared, offset);
}

/** Insert only when the saved collaborative position still resolves, and verify the result. */
export function insertResearchReference(
	editor: LexicalEditor,
	binding: Binding,
	position: Y.RelativePosition,
	id: string,
): boolean {
	let key: string | undefined;
	try {
		editor.update(() => {
			let resolved = $getAnchorAndFocusForUserState(binding, {
				anchorPos: position,
				focusPos: position,
				color: "",
				focusing: false,
				name: "",
				awarenessData: {},
			});
			if (!resolved.anchorKey || !resolved.focusKey) return;
			let anchor = $getNodeByKey(resolved.anchorKey);
			let focus = $getNodeByKey(resolved.focusKey);
			if (!anchor || !focus) return;
			let selection = $createRangeSelection();
			selection.anchor.set(
				resolved.anchorKey,
				resolved.anchorOffset,
				$isElementNode(anchor) ? "element" : "text",
			);
			selection.focus.set(
				resolved.focusKey,
				resolved.focusOffset,
				$isElementNode(focus) ? "element" : "text",
			);
			$setSelection(selection);
			let reference = $createResearchNode(id);
			$insertNodes([reference]);
			key = reference.getKey();
		}, { discrete: true });
	} catch {
		return false;
	}
	if (!key) return false;
	let inserted = false;
	editor.getEditorState().read(() => {
		let reference = $getNodeByKey(key!);
		inserted = $isResearchNode(reference) && reference.getId() === id && reference.isAttached();
	});
	return inserted;
}

export function dismissResearchComposer(
	editor: Pick<LexicalEditor, "focus">,
	dismiss: () => void,
): void {
	dismiss();
	editor.focus();
}

export function beginResearchDraft(
	drafts: ResearchDraftStore,
	consume: () => { anchor: DOMRectLike; position?: Y.RelativePosition } | undefined,
): boolean {
	if (!drafts.canOpen()) return false;
	let next = consume();
	return next ? drafts.open(next.anchor, next.position) : false;
}

export type ResearchComposerSurfaceProps = {
	binding?: Binding;
	disabled?: boolean;
	drafts: ResearchDraftStore;
	research: ResearchStore;
};

export function ResearchComposerSurface(
	{ binding, disabled, drafts, research }: ResearchComposerSurfaceProps,
) {
	let [editor] = useLexicalComposerContext();
	let subscribe = useCallback((listener: () => void) => drafts.subscribe(listener), [drafts]);
	let read = useCallback(() => drafts.get(), [drafts]);
	let draft = useSyncExternalStore(subscribe, read, read);
	let surface = useRef<HTMLDivElement>(null);
	let [position, setPosition] = useState<SurfacePlacement>();

	useEffect(() =>
		editor.registerCommand(
			OPEN_RESEARCH_COMMAND,
			({ anchor, consume }) => {
				if (disabled) return false;
				return beginResearchDraft(drafts, () => {
					if (!consume()) return;
					return {
						anchor,
						position: binding ? captureResearchPosition(binding) : undefined,
					};
				});
			},
			COMMAND_PRIORITY_LOW,
		), [binding, disabled, drafts, editor]);

	let place = useCallback(() => {
		let element = surface.current;
		if (!element || !draft) return;
		let viewport = editorSurfaceViewport(editor);
		element.style.maxWidth = `${Math.max(0, viewport.width - 16)}px`;
		let next = placeSurface(
			draft.anchor,
			{ width: element.offsetWidth, height: element.scrollHeight },
			viewport,
		);
		setPosition(current =>
			current?.left === next.left && current.top === next.top
				&& current.maxHeight === next.maxHeight
				? current
				: next
		);
	}, [draft, editor]);

	useLayoutEffect(() => {
		if (draft) place();
	}, [draft, place]);

	useEffect(() => {
		if (!draft) return;
		return listenToEditorGeometry(editor, place);
	}, [draft, editor, place]);

	useLayoutEffect(() => {
		if (!binding || disabled) return;
		return drafts.attachPlacement((saved, id) =>
			insertResearchReference(editor, binding, saved, id)
		);
	}, [binding, disabled, drafts, editor]);

	if (!draft) return null;
	let dismiss = () => dismissResearchComposer(editor, () => drafts.dismiss());
	let currentPosition = () => {
		if (!binding) return;
		let found: Y.RelativePosition | undefined;
		editor.getEditorState().read(() => {
			found = captureResearchPosition(binding);
		});
		return found;
	};
	let submit = () => {
		if (!draft.question.trim() || !binding || disabled) return;
		if (draft.phase === "placement") {
			let saved = currentPosition();
			if (saved) drafts.place(saved);
			return;
		}
		if (draft.phase !== "editing") return;
		void drafts.start(
			(question, requestId) => research.create(question, requestId),
			currentPosition(),
		);
	};
	let cancel = () => {
		if (draft.phase === "editing") return dismiss();
		if (draft.phase !== "placement" || disabled) return;
		void drafts.cancelCreated(id => research.cancel(id)).then(cancelled => {
			if (cancelled) editor.focus();
		});
	};
	let busy = draft.phase === "starting" || draft.phase === "cancelling";
	let created = draft.phase === "placement" || draft.phase === "cancelling";
	return (
		<div
			ref={surface}
			aria-label="Start research"
			role="dialog"
			data-focus-boundary=""
			contentEditable={false}
			className={`${SHELL} plan-research-composer-surface`}
			style={position
				? { top: position.top, left: position.left, maxHeight: position.maxHeight }
				: {
					top: draft.anchor.bottom + 8,
					left: draft.anchor.left,
					visibility: "hidden",
				}}
		>
			<ResearchComposer
				blocked={disabled
					? "Wait until the document is editable before placing research."
					: binding
					? undefined
					: "Connect to the document before starting research."}
				busyLabel={draft.phase === "cancelling" ? "Cancelling…" : undefined}
				cancelDisabled={created && !!disabled}
				cancelLabel={created ? "Cancel research" : undefined}
				dismissible={draft.phase === "editing"}
				error={draft.error}
				onCancel={cancel}
				onChange={question => drafts.change(question)}
				onEscape={dismiss}
				onSubmit={submit}
				question={draft.question}
				questionLocked={created}
				submitLabel={created ? "Place research here" : undefined}
				submitting={busy}
			/>
		</div>
	);
}
