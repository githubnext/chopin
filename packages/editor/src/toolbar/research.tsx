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
	$setSelection,
	COMMAND_PRIORITY_LOW,
	createCommand,
} from "lexical";
import { $createResearchNode, $isResearchNode } from "@chopin/dialect";
import * as Y from "yjs";

import { blockElement, planScroller } from "../scroll";
import { useTransitionPresence } from "../transition-presence";
import { ResearchComposer } from "../widgets/research";
import { draftOverflow, placeDraft, revealTarget } from "./placement";
import { $relativePosition } from "./position";
import { editorSurfaceViewport, listenToEditorGeometry } from "./surface";

import type { Binding } from "@lexical/yjs";
import type { LexicalEditor } from "lexical";
import type { CSSProperties, ReactNode, Ref } from "react";
import type { ResearchDraftStore } from "../research-draft";
import type { ResearchStore } from "../widget-options";
import type { DOMRectLike, DraftPlacement, ViewportBox } from "./placement";

type Attachment = { block: HTMLElement; rect: DOMRectLike };
type Position = {
	left: number;
	top: number;
	side: DraftPlacement["side"];
	clip?: string;
};

// Long enough to outlast the editor's own scroll after the slash command's Enter.
const REVEAL_WINDOW = 600;

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

export const UNRESOLVED_DRAFT = "This research draft cannot yet be placed at its saved position.";

export function ResearchDraftShell(
	{ children, inert, motion, side, surfaceRef, style }: {
		children?: ReactNode;
		inert?: boolean;
		motion?: string;
		side?: DraftPlacement["side"];
		surfaceRef?: Ref<HTMLDivElement>;
		style?: CSSProperties;
	},
) {
	return (
		<div
			ref={surfaceRef}
			aria-hidden={inert ? "true" : undefined}
			aria-label="Research question"
			role="region"
			data-focus-boundary=""
			data-side={side}
			contentEditable={false}
			className="fixed z-50 plan-research-draft motion-research-draft"
			data-motion={motion || undefined}
			inert={inert}
			style={style}
		>
			{children}
		</div>
	);
}

/** The pixels a draft may occupy: the visible scroller inside the visual viewport. */
function draftBounds(editor: LexicalEditor): ViewportBox {
	let bounds = editorSurfaceViewport(editor);
	let scroller = planScroller(editor.getRootElement())?.getBoundingClientRect();
	if (!scroller) return bounds;
	let top = Math.max(bounds.top, scroller.top);
	let bottom = Math.min(bounds.top + bounds.height, scroller.bottom);
	return { ...bounds, top, height: Math.max(0, bottom - top) };
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
	let revealUntil = useRef(0);
	let openedAt = useRef<number>(undefined);
	let presence = useTransitionPresence(draft, 150, false);
	let shown = presence.value;
	let visible = !!draft;

	useEffect(() =>
		editor.registerCommand(
			OPEN_RESEARCH_COMMAND,
			({ anchor, consume }) => {
				if (disabled) return false;
				openedAt.current = planScroller(editor.getRootElement())?.scrollTop;
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
		let bounds = draftBounds(editor);
		let column = attachment ? anchor.width : Infinity;
		element.style.maxWidth = `${Math.max(0, Math.min(bounds.width - 16, column))}px`;
		let height = element.offsetHeight;
		reserve(attachment?.block, height);
		let surfaceSize = { width: element.offsetWidth, height };
		let next = placeDraft(anchor, surfaceSize, bounds);
		let scroller = planScroller(editor.getRootElement());
		if (next.reveal !== 0 && scroller && performance.now() < revealUntil.current) {
			let target = revealTarget(
				scroller.scrollTop,
				openedAt.current,
				shift =>
					placeDraft(
						{ ...anchor, top: anchor.top + shift, bottom: anchor.bottom + shift },
						surfaceSize,
						bounds,
					),
				next.reveal,
			);
			// A long trip is a jump, not a glide past the whole document.
			let far = Math.abs(target - scroller.scrollTop) > bounds.height;
			let reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
			scroller.scrollTo({ top: target, behavior: far || reduced ? "auto" : "smooth" });
		}
		// The draft is fixed, so clip whatever has scrolled past the pane instead of drawing over its chrome.
		let overflow = draftOverflow(next.top, height, bounds);
		let clip = overflow.top || overflow.bottom
			? `inset(${overflow.top || -8}px -8px ${overflow.bottom || -8}px)`
			: undefined;
		setPosition(current =>
			current?.left === next.left && current.top === next.top && current.side === next.side
				&& current.clip === clip
				? current
				: { left: next.left, top: next.top, side: next.side, clip }
		);
	}, [binding, draft, editor, reserve]);

	useLayoutEffect(() => {
		if (!visible) return;
		setPosition(undefined);
		revealUntil.current = performance.now() + REVEAL_WINDOW;
	}, [visible]);
	useLayoutEffect(() => {
		if (!draft) {
			detach();
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
		return listenToEditorGeometry(editor, place);
	}, [draft, editor, place]);
	useEffect(() => {
		if (!visible) return;
		// An on-screen keyboard shrinks the viewport after focus; bring the draft back.
		let resized = () => {
			if (!surface.current?.contains(document.activeElement)) return;
			openedAt.current = undefined;
			revealUntil.current = performance.now() + REVEAL_WINDOW;
		};
		// Any user input ends a reveal, so it never fights the reader's own scroll or click.
		let interrupted = () => {
			revealUntil.current = 0;
		};
		let inputs = ["keydown", "pointerdown", "touchstart", "wheel"];
		let viewport = window.visualViewport;
		window.addEventListener("resize", resized, true);
		viewport?.addEventListener("resize", resized, true);
		for (let input of inputs) window.addEventListener(input, interrupted, true);
		return () => {
			window.removeEventListener("resize", resized, true);
			viewport?.removeEventListener("resize", resized, true);
			for (let input of inputs) window.removeEventListener(input, interrupted, true);
		};
	}, [visible]);
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

	if (!shown) return null;
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
	return (
		<ResearchDraftShell
			motion={presence.className}
			inert={!draft}
			side={position?.side}
			surfaceRef={surface}
			style={position
				? { top: position.top, left: position.left, clipPath: position.clip }
				: {
					top: current.anchor.bottom,
					left: current.anchor.left,
					visibility: "hidden",
				}}
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
				notice={unresolved ? UNRESOLVED_DRAFT : undefined}
				onCancel={cancel}
				onChange={question => drafts.change(question)}
				onEscape={dismiss}
				onSubmit={submit}
				question={current.question}
				questionLocked={!!current.created}
				submitLabel={current.created ? "Place research" : undefined}
				submitting={busy}
			/>
		</ResearchDraftShell>
	);
}
