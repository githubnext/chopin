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
import {
	$createInvestigationNode,
	$createResearchNode,
	$isInvestigationNode,
	$isResearchNode,
} from "@chopin/dialect";
import * as Y from "yjs";

import { blockElement } from "../scroll";
import { useTransitionPresence } from "../transition-presence";
import { ResearchComposer } from "../widgets/research";
import { $topLevel } from "./block-target";
import { $relativePosition } from "./position";

import type { Binding } from "@lexical/yjs";
import type { LexicalEditor, LexicalNode } from "lexical";
import type { ReactNode, Ref } from "react";
import type { ResearchDraftStore } from "../research-draft";
import type { DOMRectLike } from "./placement";

type Placement = "before" | "after";
type Attachment = { block: HTMLElement; placement: Placement };

export type OpenResearch = {
	anchor: DOMRectLike;
	consume: () => boolean;
};

export const OPEN_RESEARCH_COMMAND = createCommand<OpenResearch>("OPEN_RESEARCH_COMMAND");
export const OPEN_INVESTIGATION_COMMAND = createCommand<OpenResearch>(
	"OPEN_INVESTIGATION_COMMAND",
);

/** The two kinds of brief that open a private composer at the caret and place an atomic card. */
export type DraftKind = "research" | "investigation";

const KINDS = {
	research: {
		command: OPEN_RESEARCH_COMMAND,
		create: $createResearchNode,
		is: $isResearchNode,
		region: "Research question",
		blocked: "Wait until the document is editable before placing research.",
		offline: "Connect to the document before starting research.",
		unresolved: "This research draft cannot yet be placed at its saved position.",
		cancel: "Cancel research",
		place: "Place research",
		composer: {
			label: "Research question",
			placeholder: "What should Chopin research?",
			submitLabel: "Start research",
			discard: "Discard research",
			discardLabel: "Discard research question",
		},
	},
	investigation: {
		command: OPEN_INVESTIGATION_COMMAND,
		create: $createInvestigationNode,
		is: $isInvestigationNode,
		region: "Investigation brief",
		blocked: "Wait until the document is editable before placing an investigation.",
		offline: "Connect to the document before proposing an investigation.",
		unresolved: "This investigation draft cannot yet be placed at its saved position.",
		cancel: "Cancel investigation",
		place: "Place investigation",
		composer: {
			label: "Investigation brief",
			placeholder: "What should your local agent investigate?",
			submitLabel: "Propose investigation",
			discard: "Discard investigation",
			discardLabel: "Discard investigation brief",
		},
	},
} as const;

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
	kind: DraftKind = "research",
): boolean {
	let { create, is } = KINDS[kind];
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
			let reference = create(id);
			$insertResearch(reference);
			key = reference.getKey();
		}, { discrete: true });
	} catch {
		return false;
	}
	if (!key) return false;
	let inserted = false;
	editor.getEditorState().read(() => {
		let reference = $getNodeByKey(key!);
		inserted = is(reference) && reference.getId() === id && reference.isAttached();
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
export function attachDraft(
	block: HTMLElement,
	host: HTMLElement,
	placement: Placement = "after",
): () => void {
	block.dataset.researchDraftAnchor = "";
	if (placement === "before") block.before(host);
	else block.after(host);
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

/**
 * Insert a reference at the selection. Like the slash menu, a point in a list
 * item or table cell puts it after the whole list or table: a cell holds only
 * inline text in the dialect, and a list item cannot hold the block.
 */
export function $insertResearch(reference: LexicalNode): void {
	let selection = $getSelection();
	if (!$isRangeSelection(selection)) return;
	let target = $topLevel(selection.anchor.getNode());
	if (target?.nested) target.block.insertAfter(reference);
	else $insertNodes([reference]);
}

/**
 * Where the draft shows relative to the top-level block holding a saved point,
 * matching `$insertResearch`: before a block whose start it is, otherwise after
 * it. An empty block is replaced by the reference, so the draft follows it and
 * CSS lets the draft take its line.
 */
export function $draftAttachment(
	key: string,
	offset: number,
): { key: string; placement: Placement } | undefined {
	let node = $getNodeByKey(key);
	let target = node ? $topLevel(node) : undefined;
	if (!node || !target) return undefined;
	let { block, nested } = target;
	let first = $isElementNode(block) ? block.getFirstDescendant() : null;
	let atStart = !nested && offset === 0 && (node === block || first === node);
	let empty = $isElementNode(block) && block.getTextContentSize() === 0;
	return { key: block.getKey(), placement: atStart && !empty ? "before" : "after" };
}

export const UNRESOLVED_DRAFT = KINDS.research.unresolved;

export function ResearchDraftShell(
	{ children, inert, label = KINDS.research.region, motion, surfaceRef }: {
		children?: ReactNode;
		inert?: boolean;
		label?: string;
		motion?: string;
		surfaceRef?: Ref<HTMLDivElement>;
	},
) {
	return (
		<div
			ref={surfaceRef}
			aria-hidden={inert ? "true" : undefined}
			aria-label={label}
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
	let target: ReturnType<typeof $draftAttachment>;
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
			if (resolved.anchorKey) target = $draftAttachment(resolved.anchorKey, resolved.anchorOffset);
		});
	} catch {
		return undefined;
	}
	if (!target) return undefined;
	let block = blockElement(editor, target.key);
	return block ? { block, placement: target.placement } : undefined;
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
	kind?: DraftKind;
	create: (brief: string, requestId: string) => Promise<{ id: string }>;
	cancel: (id: string) => Promise<unknown>;
};

export function ResearchComposerSurface(
	{ binding, disabled, drafts, kind = "research", create, cancel: cancelCreated }:
		ResearchComposerSurfaceProps,
) {
	let copy = KINDS[kind];
	let [editor] = useLexicalComposerContext();
	let subscribe = useCallback((listener: () => void) => drafts.subscribe(listener), [drafts]);
	let read = useCallback(() => drafts.get(), [drafts]);
	let draft = useSyncExternalStore(subscribe, read, read);
	let surface = useRef<HTMLDivElement>(null);
	let attached = useRef<Attachment & { detach: () => void } | undefined>(undefined);
	let slot = useRef<HTMLDivElement | undefined>(undefined);
	let [host, setHost] = useState<HTMLDivElement>();
	let [unresolved, setUnresolved] = useState(false);
	let presence = useTransitionPresence(draft, 150, false);
	let shown = presence.value;
	let visible = !!draft;

	useEffect(() =>
		editor.registerCommand(
			copy.command,
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
		), [binding, copy, disabled, drafts, editor]);

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
		let previous = attached.current;
		if (previous && !previous.block.isConnected) previous = undefined;
		let next = retainDraftBlock(resolved, previous);
		setUnresolved(!!binding && !!draft.position && !resolved);
		if (!next) {
			if (host.parentElement !== root) root.append(host);
			return;
		}
		let { block, placement } = next;
		let sibling = placement === "before" ? block.previousElementSibling : block.nextElementSibling;
		if (
			attached.current?.block === block && attached.current.placement === placement
			&& sibling === host
		) return;
		detach();
		attached.current = { block, placement, detach: attachDraft(block, host, placement) };
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
			// React handles portal events on this host; keep native keys out of Lexical.
			element.addEventListener("keydown", event => event.stopPropagation());
			element.addEventListener("focusout", () => {
				let selection = element.ownerDocument.getSelection();
				if (selection?.anchorNode && element.contains(selection.anchorNode)) {
					selection.removeAllRanges();
				}
			});
			slot.current = element;
			setHost(element);
		}
		place();
	}, [detach, place, shown]);
	useLayoutEffect(() => {
		// Restore the caret after the closing draft becomes inert.
		if (shown && !draft) editor.focus();
	}, [draft, editor, shown]);
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
			insertResearchReference(editor, binding, saved, id, kind)
		);
	}, [binding, disabled, drafts, editor, kind]);

	if (!shown || !host) return null;
	let current = draft ?? shown;
	let dismiss = () => drafts.dismiss();
	let submit = () => {
		if (!draft || draft.submitting || draft.cancelling || !draft.question.trim()) return;
		if (!binding || disabled) return;
		let position = currentPosition(editor, binding);
		if (draft.created) {
			if (position) drafts.place(position, !disabled);
			return;
		}
		void drafts.start(create, position);
	};
	let cancel = () => {
		if (!draft) return;
		if (!draft.created) return dismiss();
		if (disabled) return;
		void drafts.cancelCreated(cancelCreated, !disabled).then(cancelled => {
			if (cancelled) editor.focus();
		});
	};
	let busy = !!current.submitting || !!current.cancelling;
	let dismissible = !busy && !current.created;
	return createPortal(
		<ResearchDraftShell
			label={copy.region}
			motion={presence.className}
			inert={!draft}
			surfaceRef={surface}
		>
			<ResearchComposer
				blocked={disabled ? copy.blocked : binding ? undefined : copy.offline}
				cancelDisabled={!!current.created && !!disabled}
				cancelLabel={current.created ? copy.cancel : undefined}
				discard={copy.composer.discard}
				discardLabel={copy.composer.discardLabel}
				dismissible={dismissible}
				error={current.error}
				label={copy.composer.label}
				notice={draft && !busy && unresolved ? copy.unresolved : undefined}
				onCancel={cancel}
				onChange={question => drafts.change(question)}
				onEscape={dismiss}
				onSubmit={submit}
				placeholder={copy.composer.placeholder}
				question={current.question}
				questionLocked={!!current.created}
				submitLabel={current.created ? copy.place : copy.composer.submitLabel}
				submitting={busy}
			/>
		</ResearchDraftShell>,
		host,
	);
}
