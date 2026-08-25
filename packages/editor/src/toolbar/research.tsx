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

import { blockElement } from "../scroll";
import { ResearchComposer } from "../widgets/research";
import { editorSurfaceViewport, listenToEditorGeometry } from "./surface";

import type { Binding } from "@lexical/yjs";
import type { LexicalEditor } from "lexical";
import type { CSSProperties, ReactNode, Ref } from "react";
import type { ResearchDraftStore } from "../research-draft";
import type { ResearchStore } from "../widget-options";
import type { DOMRectLike } from "./placement";

type Attachment = { block: HTMLElement; rect: DOMRectLike };
type Position = { left: number; top: number };

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

export function attachDraft(block: HTMLElement, height: number): () => void {
	block.dataset.researchDraftAnchor = "";
	block.style.setProperty("--research-draft-space", `${height}px`);
	return () => {
		delete block.dataset.researchDraftAnchor;
		block.style.removeProperty("--research-draft-space");
	};
}

export function retainDraftBlock<Block>(
	resolved: Block | undefined,
	previous: Block | undefined,
): Block | undefined {
	return resolved ?? previous;
}

export function attachmentBlock<Block>(
	resolved: Block,
	offset: number,
	previous: Block | undefined,
): Block {
	return offset === 0 && previous ? previous : resolved;
}

export function ResearchDraftRecovery({ unresolved }: { unresolved: boolean }) {
	return unresolved
		? (
			<p role="alert" className="plan-research-error">
				This research draft cannot yet be placed at its saved position.
			</p>
		)
		: null;
}

export function ResearchDraftShell(
	{ children, surfaceRef, style }: {
		children?: ReactNode;
		surfaceRef?: Ref<HTMLDivElement>;
		style?: CSSProperties;
	},
) {
	return (
		<div
			ref={surfaceRef}
			aria-label="Research question"
			role="region"
			data-focus-boundary=""
			contentEditable={false}
			className="fixed z-50 plan-research-draft"
			style={style}
		>
			{children}
		</div>
	);
}

function resolveAttachment(
	editor: ReturnType<typeof useLexicalComposerContext>[0],
	binding: Binding,
	position: Y.RelativePosition,
): Attachment | undefined {
	let key: string | undefined;
	let offset = 0;
	try {
		editor.getEditorState().read(() => {
			let resolved = $getAnchorAndFocusForUserState(binding, {
				anchorPos: position,
				focusPos: position,
				color: "",
				focusing: false,
				name: "",
				awarenessData: {},
			});
			key = resolved.anchorKey || undefined;
			offset = resolved.anchorOffset;
		});
	} catch {
		return undefined;
	}
	if (!key) return undefined;
	let resolved = blockElement(editor, key);
	let block = resolved
		? attachmentBlock(
			resolved,
			offset,
			resolved.previousElementSibling as HTMLElement | null ?? undefined,
		)
		: undefined;
	return block ? { block, rect: block.getBoundingClientRect() } : undefined;
}

function currentPosition(
	editor: ReturnType<typeof useLexicalComposerContext>[0],
	binding?: Binding,
): Y.RelativePosition | undefined {
	if (!binding) return undefined;
	let found: Y.RelativePosition | undefined;
	editor.getEditorState().read(() => {
		found = captureResearchPosition(binding);
	});
	return found;
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
	let attached = useRef<
		{
			block: HTMLElement;
			height: number;
			detach: () => void;
		} | undefined
	>(undefined);
	let [position, setPosition] = useState<Position>();
	let [unresolved, setUnresolved] = useState(false);
	let visible = !!draft;

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

	let detach = useCallback(() => {
		attached.current?.detach();
		attached.current = undefined;
	}, []);
	let reserve = useCallback((block: HTMLElement | undefined, height: number) => {
		let current = attached.current;
		if (current && current.block === block && current.height === height) return;
		detach();
		if (block) attached.current = { block, height, detach: attachDraft(block, height) };
	}, [detach]);

	let place = useCallback(() => {
		let element = surface.current;
		if (!element || !draft) return;
		let resolved = binding && draft.position
			? resolveAttachment(editor, binding, draft.position)
			: undefined;
		let previous = attached.current?.block;
		if (previous && !previous.isConnected) previous = undefined;
		let block = retainDraftBlock(resolved?.block, previous);
		let attachment = resolved ?? (block
			? { block, rect: block.getBoundingClientRect() }
			: undefined);
		setUnresolved(!!binding && !!draft.position && !resolved);
		let anchor = attachment?.rect ?? draft.anchor;
		let viewport = editorSurfaceViewport(editor);
		element.style.maxWidth = `${Math.max(0, viewport.width - 16)}px`;
		let height = element.offsetHeight;
		reserve(attachment?.block, height);
		let leftEdge = viewport.left + 8;
		let rightEdge = viewport.left + viewport.width - element.offsetWidth - 8;
		let next = {
			left: Math.min(Math.max(anchor.left, leftEdge), Math.max(leftEdge, rightEdge)),
			top: anchor.bottom,
		};
		setPosition(current =>
			current?.left === next.left && current.top === next.top ? current : next
		);
	}, [binding, draft, editor, reserve]);

	useLayoutEffect(() => {
		if (!draft) {
			detach();
			setPosition(undefined);
			setUnresolved(false);
			return;
		}
		place();
		let element = surface.current;
		if (!element || typeof ResizeObserver === "undefined") return;
		let observer = new ResizeObserver(place);
		observer.observe(element);
		return () => observer.disconnect();
	}, [detach, draft, place]);

	useEffect(() => detach, [detach]);
	useEffect(() => {
		if (!visible) return;
		let frame = requestAnimationFrame(() => {
			surface.current?.querySelector("textarea")?.focus({ preventScroll: true });
		});
		return () => cancelAnimationFrame(frame);
	}, [visible]);
	useEffect(() => {
		if (!draft) return;
		return listenToEditorGeometry(editor, place);
	}, [draft, editor, place]);
	useEffect(() => {
		if (!draft) return;
		return editor.registerUpdateListener(place);
	}, [draft, editor, place]);

	useLayoutEffect(() => {
		if (!binding || disabled) return;
		return drafts.attachPlacement((saved, id) =>
			insertResearchReference(editor, binding, saved, id)
		);
	}, [binding, disabled, drafts, editor]);

	if (!draft) return null;
	let dismiss = () => {
		drafts.dismiss();
		editor.focus();
	};
	let submit = () => {
		if (draft.submitting || draft.cancelling || !draft.question.trim()) return;
		if (!binding || disabled) return;
		let position = currentPosition(editor, binding);
		if (draft.created) {
			if (position) drafts.place(position, !disabled);
			return;
		}
		void drafts.start(
			(question, requestId) => research.create(question, requestId),
			position,
		);
	};
	let cancel = () => {
		if (!draft.created) return dismiss();
		if (disabled) return;
		void drafts.cancelCreated(id => research.cancel(id), !disabled).then(cancelled => {
			if (cancelled) editor.focus();
		});
	};
	let busy = !!draft.submitting || !!draft.cancelling;
	let dismissible = !busy && !draft.created;
	return (
		<ResearchDraftShell
			surfaceRef={surface}
			style={position
				? { top: position.top, left: position.left }
				: {
					top: draft.anchor.bottom,
					left: draft.anchor.left,
					visibility: "hidden",
				}}
		>
			<ResearchDraftRecovery unresolved={unresolved && !draft.error} />
			<ResearchComposer
				blocked={disabled
					? "Wait until the document is editable before placing research."
					: binding
					? undefined
					: "Connect to the document before starting research."}
				cancelDisabled={!!draft.created && !!disabled}
				cancelLabel={draft.created ? "Cancel research" : undefined}
				dismissible={dismissible}
				error={draft.error}
				onCancel={cancel}
				onChange={question => drafts.change(question)}
				onEscape={dismiss}
				onSubmit={submit}
				question={draft.question}
				questionLocked={!!draft.created}
				submitLabel={draft.created ? "Place research here" : undefined}
				submitting={busy}
			/>
		</ResearchDraftShell>
	);
}
