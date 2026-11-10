import { memo, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CloseIcon, RestartIcon } from "@chopin/icons";

import { useMenuDismissal } from "../../menu-dismissal";
import { MenuItem, MenuSeparator } from "../../menu-item";
import { LongPress } from "../long-press";
import { QUICK_REACTIONS } from "../reactions";
import { EmojiPicker } from "./emoji-picker";
import { CopySwap, MessageActions } from "./message-actions";
import { useCopyToClipboard } from "./use-copy-to-clipboard";

import type { CSSProperties, KeyboardEvent, RefObject } from "react";

export let COPIED_MS = 1500;

const TOOLBAR_MARGIN = 8;
const SHIFT = "--chat-toolbar-shift";

type Which = "markdown" | "plain";

export type ToolbarActions = {
	plain: () => string;
	react: (emoji: string, on: boolean) => void;
	delete: () => void;
	retry: () => void;
};

export type MessageToolbarProps = {
	host: RefObject<HTMLElement | null>;
	markdown: string;
	reacted: ReadonlySet<string>;
	reactable: boolean;
	canDelete: boolean;
	canRetry: boolean;
	actions: RefObject<ToolbarActions>;
	persistent: boolean;
};

function sameToolbar(before: MessageToolbarProps, after: MessageToolbarProps): boolean {
	return before.host === after.host && before.markdown === after.markdown
		&& before.reactable === after.reactable
		&& before.canDelete === after.canDelete && before.canRetry === after.canRetry
		&& before.persistent === after.persistent
		&& before.actions === after.actions && before.reacted.size === after.reacted.size
		&& [...before.reacted].every(emoji => after.reacted.has(emoji));
}

function useAnchored(
	open: boolean,
	anchor: RefObject<HTMLElement | null>,
	panel: RefObject<HTMLElement | null>,
	align: "end" | "start",
) {
	let [position, setPosition] = useState<CSSProperties>();
	useLayoutEffect(() => {
		let element = panel.current;
		if (!open || !element) {
			setPosition(undefined);
			return;
		}
		let margin = 8;
		let gap = 4;
		let place = () => {
			let box = anchor.current?.getBoundingClientRect();
			if (!box) return;
			let width = element.offsetWidth;
			let height = element.offsetHeight;
			let below = box.bottom + gap;
			let above = box.top - gap - height;
			let top = below + height + margin <= window.innerHeight
				? below
				: above >= margin
				? above
				: Math.max(margin, Math.min(below, window.innerHeight - margin - height));
			let wanted = align === "end" ? box.right - width : box.left;
			let left = Math.max(margin, Math.min(wanted, window.innerWidth - width - margin));
			setPosition(current =>
				current?.left === left && current.top === top
					? current
					: { left, top, visibility: "visible" }
			);
		};
		place();
		let observer = new ResizeObserver(place);
		observer.observe(element);
		window.addEventListener("resize", place);
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", place);
		};
	}, [open, anchor, panel, align]);
	return position;
}

function move(event: KeyboardEvent<HTMLElement>) {
	let key = event.key;
	if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(key)) return false;
	let items = [
		...event.currentTarget.querySelectorAll<HTMLElement>("[role=menuitem]:not(:disabled)"),
	];
	if (items.length === 0) return false;
	event.preventDefault();
	event.stopPropagation();
	let at = Math.max(0, items.indexOf(document.activeElement as HTMLElement));
	let next = key === "Home"
		? 0
		: key === "End"
		? items.length - 1
		: (at + (key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
	items[next]?.focus();
	return true;
}

export let MessageToolbar = memo(function MessageToolbar(
	{
		actions,
		canDelete,
		canRetry,
		host,
		markdown,
		persistent,
		reactable,
		reacted,
	}: MessageToolbarProps,
) {
	let menuId = useId();
	let pickerId = useId();
	let addButton = useRef<HTMLButtonElement>(null);
	let moreButton = useRef<HTMLButtonElement>(null);
	let menu = useRef<HTMLDivElement>(null);
	let picker = useRef<HTMLDivElement>(null);
	let [menuOpen, setMenuOpen] = useState(false);
	let [pickerOpen, setPickerOpen] = useState(false);
	let [pinned, setPinned] = useState(false);
	let [copying, setCopying] = useState<Which>();
	let { isCopied, isFailed, copyToClipboard } = useCopyToClipboard({ copiedDuration: COPIED_MS });
	let engaged = pinned || menuOpen || pickerOpen || isCopied || isFailed;

	let menuPosition = useAnchored(menuOpen, moreButton, menu, "end");
	let pickerPosition = useAnchored(pickerOpen, addButton, picker, "end");
	let menuPlaced = !!menuPosition;
	let pickerPlaced = !!pickerPosition;
	let closeMenu = (restoreFocus = false) => {
		setMenuOpen(false);
		if (restoreFocus) moreButton.current?.focus();
	};
	let closePicker = (restoreFocus = false) => {
		setPickerOpen(false);
		if (restoreFocus) addButton.current?.focus();
	};
	useMenuDismissal(menuOpen, [moreButton, menu], closeMenu);
	useMenuDismissal(pickerOpen, [addButton, picker], closePicker);
	useMenuDismissal(
		pinned && !menuOpen && !pickerOpen,
		[host, menu, picker],
		() => setPinned(false),
	);

	useEffect(() => {
		let element = host.current;
		element?.toggleAttribute("data-chat-engaged", engaged || persistent);
		return () => element?.removeAttribute("data-chat-engaged");
	}, [host, engaged, persistent]);

	// A message taller than the pane has its top, and so its toolbar, above what is shown: while the
	// pointer or focus is on it, the bar is moved down the message to the top of the visible part.
	useEffect(() => {
		let element = host.current;
		let view = element?.closest<HTMLElement>("[data-chat-scroll]");
		if (!element || !view || !window.matchMedia("(hover: hover)").matches) return;
		let place = () => {
			let bar = element.querySelector<HTMLElement>('[data-slot="message-actions"]');
			if (!bar) return;
			let shift = Number.parseFloat(element.style.getPropertyValue(SHIFT)) || 0;
			let natural = bar.getBoundingClientRect().top - shift;
			let room = element.getBoundingClientRect().bottom - bar.offsetHeight - natural;
			let seen = view.getBoundingClientRect().top;
			// Only a message whose top has scrolled away; one whose top is shown keeps its bar where it is.
			let wanted = element.getBoundingClientRect().top < seen ? seen + TOOLBAR_MARGIN - natural : 0;
			element.style.setProperty(SHIFT, `${Math.max(0, Math.min(wanted, room))}px`);
		};
		let enter = () => {
			place();
			view.addEventListener("scroll", place, { passive: true });
		};
		let leave = () => {
			view.removeEventListener("scroll", place);
			if (!element.matches(":focus-within")) element.style.removeProperty(SHIFT);
		};
		element.addEventListener("pointerenter", enter);
		element.addEventListener("pointerleave", leave);
		element.addEventListener("focusin", enter);
		element.addEventListener("focusout", leave);
		return () => {
			element.removeEventListener("pointerenter", enter);
			element.removeEventListener("pointerleave", leave);
			element.removeEventListener("focusin", enter);
			element.removeEventListener("focusout", leave);
			view.removeEventListener("scroll", place);
			element.style.removeProperty(SHIFT);
		};
	}, [host]);

	useEffect(() => {
		if (!pinned) return;
		let bar = host.current?.querySelector<HTMLElement>('[data-slot="message-actions"]');
		let view = bar?.closest<HTMLElement>("[data-chat-scroll]");
		if (!bar || !view) return;
		let box = bar.getBoundingClientRect();
		let frame = view.getBoundingClientRect();
		// On a phone the transcript runs under the top bar, and its scroll padding is the bar's height.
		let top = frame.top + (parseFloat(getComputedStyle(view).scrollPaddingTop) || 0);
		if (box.top < top || box.bottom > frame.bottom) {
			view.scrollTop += box.top - top - TOOLBAR_MARGIN;
		}
	}, [host, pinned]);

	useEffect(() => {
		if (menuPlaced) {
			menu.current?.querySelector<HTMLElement>("[role=menuitem]:not(:disabled)")?.focus();
		}
	}, [menuPlaced]);

	useEffect(() => {
		if (pickerPlaced) picker.current?.querySelector("input")?.focus();
	}, [pickerPlaced]);

	let was = useRef(false);
	useEffect(() => {
		if (was.current && !isCopied) {
			if (menu.current?.contains(document.activeElement)) closeMenu(true);
			else setMenuOpen(false);
		}
		was.current = isCopied;
	}, [isCopied]);

	useEffect(() => {
		let element = host.current;
		if (!element) return;
		let suppress = false;
		let press = new LongPress(() => setPinned(true));
		let down = (event: PointerEvent) => {
			if (event.pointerType === "touch") press.start(event.clientX, event.clientY);
		};
		let moved = (event: PointerEvent) => press.move(event.clientX, event.clientY);
		let up = () => {
			if (press.end()) {
				suppress = true;
				setTimeout(() => suppress = false, 500);
			}
		};
		let click = (event: MouseEvent) => {
			if (!suppress) return;
			suppress = false;
			event.preventDefault();
			event.stopPropagation();
		};
		let contextMenu = (event: Event) => {
			if (matchMedia("(hover: none)").matches) event.preventDefault();
		};
		element.addEventListener("pointerdown", down);
		element.addEventListener("pointermove", moved);
		element.addEventListener("pointerup", up);
		element.addEventListener("pointercancel", up);
		element.addEventListener("click", click, true);
		element.addEventListener("contextmenu", contextMenu);
		return () => {
			press.cancel();
			element.removeEventListener("pointerdown", down);
			element.removeEventListener("pointermove", moved);
			element.removeEventListener("pointerup", up);
			element.removeEventListener("pointercancel", up);
			element.removeEventListener("click", click, true);
			element.removeEventListener("contextmenu", contextMenu);
		};
	}, [host]);

	let copy = (which: Which) => {
		setCopying(which);
		copyToClipboard(which === "markdown" ? markdown : actions.current.plain());
	};
	let afterAction = () => {
		closeMenu();
		setPinned(false);
	};
	let menuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key === "Tab") return closeMenu();
		if (event.key === "Escape") return;
		move(event);
	};
	let pickerKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key === "Tab") closePicker();
	};

	return (
		<>
			<MessageActions
				addControls={pickerOpen ? pickerId : undefined}
				addExpanded={pickerOpen}
				addRef={addButton}
				className="chat-message-toolbar"
				moreControls={menuOpen ? menuId : undefined}
				moreExpanded={menuOpen}
				moreRef={moreButton}
				onAddReaction={() => {
					setMenuOpen(false);
					setPickerOpen(open => !open);
				}}
				onMore={() => {
					setPickerOpen(false);
					setCopying(undefined);
					setMenuOpen(open => !open);
				}}
				onReact={emoji => {
					actions.current.react(emoji, !reacted.has(emoji));
					setPinned(false);
				}}
				pressed={reacted}
				quick={QUICK_REACTIONS}
				reactable={reactable}
			/>
			<span aria-atomic="true" aria-live="polite" className="sr-only" role="status">
				{isCopied ? "Copied" : isFailed ? "Couldn't copy" : ""}
			</span>
			{menuOpen && createPortal(
				<div
					aria-label="Message actions"
					className="chat-message-menu"
					id={menuId}
					onKeyDownCapture={menuKeyDown}
					ref={menu}
					role="menu"
					style={menuPosition ?? { visibility: "hidden" }}
				>
					<MenuItem onClick={() => copy("markdown")}>
						<CopySwap copied={isCopied && copying === "markdown"} />
						{isCopied && copying === "markdown"
							? "Copied"
							: isFailed && copying === "markdown"
							? "Couldn't copy"
							: "Copy"}
					</MenuItem>
					<MenuItem onClick={() => copy("plain")}>
						<CopySwap copied={isCopied && copying === "plain"} />
						{isCopied && copying === "plain"
							? "Copied"
							: isFailed && copying === "plain"
							? "Couldn't copy"
							: "Copy as plain text"}
					</MenuItem>
					{canRetry && (
						<MenuItem
							onClick={() => {
								afterAction();
								actions.current.retry();
							}}
						>
							<RestartIcon aria-hidden="true" size={16} />
							Try again
						</MenuItem>
					)}
					{canDelete && <MenuSeparator />}
					{canDelete && (
						<MenuItem
							onClick={() => {
								afterAction();
								actions.current.delete();
							}}
							tone="destructive"
						>
							<CloseIcon aria-hidden="true" size={16} />
							Delete
						</MenuItem>
					)}
				</div>,
				document.body,
			)}
			{pickerOpen && createPortal(
				<div
					className="chat-message-picker"
					onKeyDownCapture={pickerKeyDown}
					ref={picker}
					style={pickerPosition ?? { visibility: "hidden" }}
				>
					<EmojiPicker
						id={pickerId}
						onPick={emoji => {
							actions.current.react(emoji, true);
							closePicker(true);
							setPinned(false);
						}}
					/>
				</div>,
				document.body,
			)}
		</>
	);
}, sameToolbar);
