/**
 * The GitHub card a pill opens on hover, or on keyboard focus where links take it.
 *
 * Lexical owns the pill's `<a>`, so there is no Base UI trigger to render:
 * the card is a controlled `PreviewCard` anchored to that element, and this
 * layer does the trigger's job with delegated pointer and focus listeners on
 * the editor root.
 *
 * The caret-driven link preview is the other surface a link can open. A
 * caret inside a pill already shows this card inside that preview, so the
 * hover card stays away from a pill that holds the caret or was just pressed,
 * and the two never stack.
 */

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { PreviewCard } from "@base-ui/react/preview-card";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $isLinkNode } from "@lexical/link";
import {
	$findMatchingParent,
	$getNearestNodeFromDOMNode,
	$getSelection,
	$isRangeSelection,
} from "lexical";
import { parseGitHubReference } from "@chopin/protocol/github-reference";

import { GitHubCard } from "./github-card";
import { useGitHubReferences } from "./github-references";

import type { GitHubReference } from "@chopin/protocol/github-reference";
import type { GitHubReferenceStore } from "./widget-options";

/** Long enough that reading across a pill does not open it. */
export const OPEN_DELAY = 450;
/** Long enough to cross the gap into the card. */
export const CLOSE_DELAY = 120;

type Target = { element: HTMLAnchorElement; reference: GitHubReference; url: string };

function pillFrom(target: EventTarget | null): HTMLAnchorElement | undefined {
	if (!(target instanceof Element)) return;
	return target.closest<HTMLAnchorElement>("a[data-gh-state]") ?? undefined;
}

/** Follows a store's answers for one reference. */
export function useGitHubEntry(store: GitHubReferenceStore, reference: GitHubReference) {
	let [, changed] = useReducer((count: number) => count + 1, 0);
	useEffect(() => store.subscribe(changed), [store]);
	return store.get(reference);
}

function HoverCard(
	{ onEnter, onLeave, store, target }: {
		onEnter: () => void;
		onLeave: () => void;
		store: GitHubReferenceStore;
		target: Target;
	},
) {
	let entry = useGitHubEntry(store, target.reference);
	return (
		<PreviewCard.Portal>
			<PreviewCard.Positioner
				align="start"
				anchor={target.element}
				className="gh-card-positioner"
				collisionPadding={8}
				sideOffset={12}
			>
				<PreviewCard.Popup
					className="gh-card-popup"
					onPointerEnter={onEnter}
					onPointerLeave={onLeave}
				>
					<GitHubCard entry={entry} reference={target.reference} url={target.url} />
				</PreviewCard.Popup>
			</PreviewCard.Positioner>
		</PreviewCard.Portal>
	);
}

export function GitHubHoverCards() {
	let [editor] = useLexicalComposerContext();
	let store = useGitHubReferences();
	let [target, setTarget] = useState<Target>();
	let [open, setOpen] = useState(false);
	let timer = useRef<ReturnType<typeof setTimeout>>(undefined);
	/** A pill just pressed: its caret preview speaks for it until the pointer leaves. */
	let pressed = useRef<HTMLAnchorElement>(undefined);

	let schedule = useCallback((run: () => void, delay: number) => {
		clearTimeout(timer.current);
		timer.current = setTimeout(run, delay);
	}, []);
	let close = useCallback(() => {
		clearTimeout(timer.current);
		setOpen(false);
	}, []);

	/** Whether the caret's link preview already shows this pill. */
	let holdsCaret = useCallback((element: HTMLAnchorElement) => {
		let root = editor.getRootElement();
		if (!root?.contains(element.ownerDocument.activeElement)) return false;
		return editor.read(() => {
			let selection = $getSelection();
			if (!$isRangeSelection(selection)) return false;
			let link = $findMatchingParent(selection.anchor.getNode(), $isLinkNode);
			let node = $getNearestNodeFromDOMNode(element);
			let pill = node && ($isLinkNode(node) ? node : $findMatchingParent(node, $isLinkNode));
			return !!link && !!pill && link.is(pill);
		});
	}, [editor]);

	let show = useCallback((element: HTMLAnchorElement, delay: number) => {
		let quiet = () => pressed.current === element || holdsCaret(element);
		if (!parseGitHubReference(element.href) || quiet()) return;
		schedule(() => {
			// The caret or a press may have reached the pill while the delay ran.
			let reference = parseGitHubReference(element.href);
			if (!reference || quiet()) return;
			// Lexical keeps the same element when a link's URL changes, so compare what it points at.
			setTarget(current =>
				current?.element === element && current.url === element.href
					? current
					: { element, reference, url: element.href }
			);
			setOpen(true);
		}, delay);
	}, [holdsCaret, schedule]);

	let hide = useCallback(() => schedule(() => setOpen(false), CLOSE_DELAY), [schedule]);

	useEffect(() => {
		if (!store) return;
		let over = (event: PointerEvent) => {
			if (event.pointerType === "touch") return;
			let pill = pillFrom(event.target);
			if (pill) show(pill, OPEN_DELAY);
		};
		let out = (event: PointerEvent) => {
			let pill = pillFrom(event.target);
			if (!pill || pill.contains(event.relatedTarget as Node | null)) return;
			if (pressed.current === pill) pressed.current = undefined;
			hide();
		};
		let down = (event: PointerEvent) => {
			let pill = pillFrom(event.target);
			if (!pill) return;
			pressed.current = pill;
			close();
		};
		// Links take focus only where the document is read-only.
		let focusIn = (event: FocusEvent) => {
			let pill = pillFrom(event.target);
			if (pill && pill === event.target) show(pill, 0);
		};
		let focusOut = (event: FocusEvent) => {
			let pill = pillFrom(event.target);
			if (!pill) return;
			// Pressed by keyboard, the pill is released when focus leaves it.
			if (pressed.current === pill) pressed.current = undefined;
			hide();
		};
		let key = (event: KeyboardEvent) => {
			if (event.key === "Escape") close();
			else if (event.key === "Enter" && pillFrom(event.target)) {
				pressed.current = pillFrom(event.target);
				close();
			}
		};
		return editor.registerRootListener((root, previous) => {
			previous?.removeEventListener("pointerover", over);
			previous?.removeEventListener("pointerout", out);
			previous?.removeEventListener("pointerdown", down);
			previous?.removeEventListener("focusin", focusIn);
			previous?.removeEventListener("focusout", focusOut);
			previous?.removeEventListener("keydown", key);
			root?.addEventListener("pointerover", over);
			root?.addEventListener("pointerout", out);
			root?.addEventListener("pointerdown", down);
			root?.addEventListener("focusin", focusIn);
			root?.addEventListener("focusout", focusOut);
			root?.addEventListener("keydown", key);
		});
	}, [close, editor, hide, show, store]);

	// The caret arriving in the pill hands it to the link preview.
	useEffect(
		() =>
			editor.registerUpdateListener(() => {
				if (target && open && holdsCaret(target.element)) close();
			}),
		[close, editor, holdsCaret, open, target],
	);

	// A pill that left the document, or now points elsewhere, takes its card with it.
	useEffect(() => {
		if (!open || !target) return;
		return editor.registerUpdateListener(() => {
			if (!target.element.isConnected || target.element.href !== target.url) close();
		});
	}, [close, editor, open, target]);

	useEffect(() => () => clearTimeout(timer.current), []);

	if (!store || !target) return null;
	return (
		<PreviewCard.Root
			onOpenChange={next => {
				if (!next) close();
			}}
			open={open}
		>
			<HoverCard
				onEnter={() => clearTimeout(timer.current)}
				onLeave={hide}
				store={store}
				target={target}
			/>
		</PreviewCard.Root>
	);
}
