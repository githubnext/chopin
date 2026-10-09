import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $getAnchorAndFocusForUserState } from "@lexical/yjs";
import {
	$createRangeSelection,
	$getNodeByKey,
	$getSelection,
	$insertNodes,
	$isElementNode,
	$isRangeSelection,
	$setSelection,
	COMMAND_PRIORITY_LOW,
	createCommand,
	setDOMUnmanaged,
} from "lexical";
import { $createResearchNode, $isResearchNode } from "@chopin/dialect";
import * as Y from "yjs";

import { blockElement } from "../scroll";
import { useTransitionPresence } from "../transition-presence";
import { ResearchComposer } from "../widgets/research";
import { $relativePosition } from "./position";

import type { Binding } from "@lexical/yjs";
import type { LexicalEditor } from "lexical";
import type { ReactNode, Ref } from "react";
import type { ResearchDraftStore } from "../research-draft";
import type { ResearchStore } from "../widget-options";
import type { DOMRectLike } from "./placement";

type Attachment = { block: HTMLElement };

export type OpenResearch = {
	anchor: DOMRectLike;
	consume: () => boolean;
};

export const OPEN_RESEARCH_COMMAND = createCommand<OpenResearch>("OPEN_RESEARCH_COMMAND");

/** Capture a document-safe insertion point before an asynchronous request begins. */
export function captureResearchPosition(binding: Binding): Y.RelativePosition | undefined {
	let selection = $getSelection();
	if (!$isRangeSelection(selection) || !selection.isCollapsed()) return;
	return $relativePosition(binding, selection.anchor);
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

/** The private surface participates in flow without becoming collaborative content. */
export function attachDraft(block: HTMLElement, host: HTMLElement): () => void {
	block.dataset.researchDraftAnchor = "";
	block.after(host);
	return () => {
		delete block.dataset.researchDraftAnchor;
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

export const UNRESOLVED_DRAFT = "This research draft cannot yet be placed at its saved position.";

export function ResearchDraftShell(
	{ children, inert, motion, surfaceRef }: {
		children?: ReactNode;
		inert?: boolean;
		motion?: string;
		surfaceRef?: Ref<HTMLDivElement>;
	},
) {
	return (
		<div
			ref={surfaceRef}
			aria-hidden={inert ? "true" : undefined}
			aria-label="Research question"
			role="region"
			data-focus-boundary=""
			contentEditable={false}
			className="plan-research-draft motion-research-draft"
			data-motion={motion || undefined}
			inert={inert}
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
	let previous = resolved?.previousElementSibling as HTMLElement | null;
	if (previous?.classList.contains("plan-research-draft-host")) {
		previous = previous.previousElementSibling as HTMLElement | null;
	}
	let block = resolved
		? attachmentBlock(
			resolved,
			offset,
			previous ?? undefined,
		)
		: undefined;
	return block ? { block } : undefined;
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
	let attached = useRef<{ block: HTMLElement; detach: () => void } | undefined>(undefined);
	let slot = useRef<HTMLDivElement | undefined>(undefined);
	let [host, setHost] = useState<HTMLDivElement>();
	let [unresolved, setUnresolved] = useState(false);
	let presence = useTransitionPresence(draft, 150, false);
	let shown = presence.value;
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
	let place = useCallback(() => {
		let root = editor.getRootElement();
		let host = slot.current;
		if (!root || !host || !draft) return;
		let resolved = binding && draft.position
			? resolveAttachment(editor, binding, draft.position)
			: undefined;
		let previous = attached.current?.block;
		if (previous && !previous.isConnected) previous = undefined;
		let block = retainDraftBlock(resolved?.block, previous);
		setUnresolved(!!binding && !!draft.position && !resolved);
		if (!block) {
			if (host.parentElement !== root) root.append(host);
			return;
		}
		if (attached.current?.block === block && block.nextElementSibling === host) return;
		detach();
		attached.current = { block, detach: attachDraft(block, host) };
	}, [binding, draft, editor, detach]);

	useLayoutEffect(() => {
		if (!shown) {
			detach();
			slot.current?.remove();
			slot.current = undefined;
			setHost(undefined);
			return;
		}
		if (!slot.current) {
			let element = document.createElement("div");
			element.className = "plan-research-draft-host";
			element.contentEditable = "false";
			setDOMUnmanaged(element, { captureSelection: true });
			slot.current = element;
			setHost(element);
		}
		place();
	}, [detach, place, shown]);
	useEffect(() => () => {
		detach();
		slot.current?.remove();
	}, [detach]);
	useEffect(() => {
		if (!visible || !host) return;
		let frame = requestAnimationFrame(() => {
			let element = surface.current;
			element?.scrollIntoView({ block: "nearest" });
			element?.querySelector("textarea")?.focus({ preventScroll: true });
		});
		return () => cancelAnimationFrame(frame);
	}, [host, visible]);
	let settled = !!draft && !draft.submitting && !draft.cancelling;
	useEffect(() => {
		// A disabled textarea drops focus while a request is in flight; return it for a retry.
		if (!settled) return;
		let textarea = surface.current?.querySelector("textarea");
		if (textarea && document.activeElement === document.body) {
			textarea.focus({ preventScroll: true });
		}
	}, [settled]);
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

	if (!shown || !host) return null;
	let current = draft ?? shown;
	let dismiss = () => {
		drafts.dismiss();
		editor.focus();
	};
	let submit = () => {
		if (!draft || draft.submitting || draft.cancelling || !draft.question.trim()) return;
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
		if (!draft) return;
		if (!draft.created) return dismiss();
		if (disabled) return;
		void drafts.cancelCreated(id => research.cancel(id), !disabled).then(cancelled => {
			if (cancelled) editor.focus();
		});
	};
	let busy = !!current.submitting || !!current.cancelling;
	let dismissible = !busy && !current.created;
	return createPortal(
		<ResearchDraftShell
			motion={presence.className}
			inert={!draft}
			surfaceRef={surface}
		>
			<ResearchComposer
				blocked={disabled
					? "Wait until the document is editable before placing research."
					: binding
					? undefined
					: "Connect to the document before starting research."}
				cancelDisabled={!!current.created && !!disabled}
				cancelLabel={current.created ? "Cancel research" : undefined}
				dismissible={dismissible}
				error={current.error}
				notice={draft && !busy && unresolved ? UNRESOLVED_DRAFT : undefined}
				onCancel={cancel}
				onChange={question => drafts.change(question)}
				onEscape={dismiss}
				onSubmit={submit}
				question={current.question}
				questionLocked={!!current.created}
				submitLabel={current.created ? "Place research" : undefined}
				submitting={busy}
			/>
		</ResearchDraftShell>,
		host,
	);
}
