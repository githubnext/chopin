import {
	cloneElement,
	lazy,
	memo,
	Suspense,
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import {
	CloseIcon,
	EllipsisVerticalIcon,
	MessageIcon,
	ReactionAddIcon,
	RestartIcon,
} from "@chopin/icons";

import { MessageActions } from "@/components/assistant-ui/elements/message-actions";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useMenuDismissal } from "../../menu-dismissal";
import { LongPress } from "../long-press";
import { QUICK_REACTIONS } from "../reactions";
import { TALL, watchTall } from "./tall-rows";
import { useCopyToClipboard } from "./use-copy-to-clipboard";

import "./message-actions.css";

import type { MessageActionItem } from "@/components/assistant-ui/elements/message-actions";
import type { CSSProperties, KeyboardEvent, RefObject } from "react";

export let COPIED_MS = 1500;

// The picker, its styles and its catalogue load the first time someone opens one.
const EmojiPicker = lazy(() =>
	import("./emoji-picker").then(module => ({ default: module.EmojiPicker }))
);

const TOOLBAR_MARGIN = 8;
const SHIFT = "--chat-toolbar-shift";
const SHEET_WIDTH = 600;
const BUTTONS = "--chat-toolbar-buttons";

type Which = "markdown" | "plain";

export type ToolbarActions = {
	plain: () => string;
	react: (emoji: string, on: boolean) => void;
	delete: () => void;
	retry: () => void;
	thread: () => void;
};

export type MessageToolbarProps = {
	host: RefObject<HTMLElement | null>;
	markdown: string;
	reacted: ReadonlySet<string>;
	reactable: boolean;
	canDelete: boolean;
	canRetry: boolean;
	actions: RefObject<ToolbarActions>;
	/** Set to what opens this message's emoji picker, for the add-reaction pill under it. */
	openPicker: RefObject<(() => void) | undefined>;
	/** The message's id, when Reply in thread can open or start its thread. */
	thread?: string;
};

function sameToolbar(before: MessageToolbarProps, after: MessageToolbarProps): boolean {
	return before.host === after.host && before.markdown === after.markdown
		&& before.reactable === after.reactable
		&& before.canDelete === after.canDelete && before.canRetry === after.canRetry
		&& before.openPicker === after.openPicker && before.thread === after.thread
		&& before.actions === after.actions && before.reacted.size === after.reacted.size
		&& [...before.reacted].every(emoji => after.reacted.has(emoji));
}

function useAnchored(
	open: boolean,
	anchor: RefObject<HTMLElement | null>,
	panel: RefObject<HTMLElement | null>,
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
			// A phone's picker is a sheet along the bottom edge, as Slack's is.
			if (window.innerWidth <= SHEET_WIDTH) {
				setPosition(current =>
					current?.bottom === 0 ? current : { left: 0, right: 0, bottom: 0, visibility: "visible" }
				);
				return;
			}
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
			let wanted = box.right - width;
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
	}, [open, anchor, panel]);
	return position;
}

function CopyMenuIcon({ copied }: { copied: boolean }) {
	return (
		<MessageActions
			copied={copied}
			renderCopy={icons => (
				<span
					aria-hidden="true"
					className="chat-copy-swap inline-grid place-items-center"
					data-copied={copied || undefined}
				>
					{icons}
				</span>
			)}
		/>
	);
}

export let MessageToolbar = memo(function MessageToolbar(
	{
		actions,
		canDelete,
		canRetry,
		host,
		markdown,
		openPicker,
		reactable,
		reacted,
		thread,
	}: MessageToolbarProps,
) {
	let pickerId = useId();
	let addButton = useRef<HTMLButtonElement>(null);
	let moreButton = useRef<HTMLButtonElement>(null);
	let picker = useRef<HTMLDivElement>(null);
	let [active, setActive] = useState(0);
	let [menuOpen, setMenuOpen] = useState(false);
	let [pickerOpen, setPickerOpen] = useState(false);
	let [pinned, setPinned] = useState(false);
	let [copying, setCopying] = useState<Which>();
	let { isCopied, isFailed, copyToClipboard } = useCopyToClipboard({ copiedDuration: COPIED_MS });
	let engaged = pinned || menuOpen || pickerOpen || isCopied || isFailed;

	let pickerPosition = useAnchored(pickerOpen, addButton, picker);
	let pickerPlaced = !!pickerPosition;
	let closePicker = (restoreFocus = false) => {
		setPickerOpen(false);
		if (restoreFocus) addButton.current?.focus();
	};
	useMenuDismissal(pickerOpen, [addButton, picker], closePicker);
	useMenuDismissal(
		pinned && !menuOpen && !pickerOpen,
		[host, picker],
		() => setPinned(false),
	);

	useEffect(() => {
		let element = host.current;
		element?.toggleAttribute("data-chat-engaged", engaged);
		return () => element?.removeAttribute("data-chat-engaged");
	}, [host, engaged]);

	useEffect(() => {
		openPicker.current = () => {
			setMenuOpen(false);
			setPickerOpen(true);
		};
		return () => {
			openPicker.current = undefined;
		};
	}, [openPicker]);

	// A message taller than the pane has its top, and so its toolbar, above what is shown: while the
	// pointer or focus is on it, the bar is moved down the message to the top of the visible part.
	useEffect(() => {
		let element = host.current;
		let view = element?.closest<HTMLElement>("[data-chat-scroll]");
		if (!element || !view || !window.matchMedia("(hover: hover)").matches) return;
		let place = () => {
			// Any other message is scrolled to whole, so its bar stays where it stands; measuring it would
			// lay the page out for the pointer's every new row.
			if (!element.hasAttribute(TALL)) {
				element.style.removeProperty(SHIFT);
				return;
			}
			let bar = element.querySelector<HTMLElement>(".chat-message-toolbar");
			if (!bar) return;
			let shift = Number.parseFloat(element.style.getPropertyValue(SHIFT)) || 0;
			let natural = bar.getBoundingClientRect().top - shift;
			let room = element.getBoundingClientRect().bottom - bar.offsetHeight - natural;
			let seen = view.getBoundingClientRect().top;
			// Only a message taller than the pane, whose top has scrolled away; any other is scrolled to.
			let tall = element.hasAttribute(TALL) && element.getBoundingClientRect().top < seen;
			let wanted = tall ? seen + TOOLBAR_MARGIN - natural : 0;
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

	// A message taller than the pane gets a column beside its text for the bar, which is kept in view
	// over it, so the bar covers none of that message's text.
	useEffect(() => {
		let element = host.current;
		let view = element?.closest<HTMLElement>("[data-chat-scroll]");
		if (!element || !view || !window.matchMedia("(hover: hover)").matches) return;
		return watchTall(element, view);
	}, [host]);

	useEffect(() => {
		if (!pinned) return;
		let bar = host.current?.querySelector<HTMLElement>(".chat-message-toolbar");
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
		if (pickerPlaced) picker.current?.querySelector("input")?.focus();
	}, [pickerPlaced]);

	let was = useRef(false);
	useEffect(() => {
		if (was.current && !isCopied && !isFailed) {
			let restore = !!document.activeElement?.closest(".chat-message-menu");
			setMenuOpen(false);
			setPinned(false);
			if (restore) moreButton.current?.focus();
		}
		was.current = isCopied;
	}, [isCopied, isFailed]);

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

	let reply = reactable ? QUICK_REACTIONS.length + 1 : 0;
	let count = reply + (thread ? 1 : 0) + 1;
	// The room the message's first line leaves for the bar, which stands over its top edge. A passive
	// effect, as the message's own ref is not yet set when a child's layout effect runs.
	useEffect(() => {
		host.current?.style.setProperty(BUTTONS, String(count));
	}, [host, count]);
	let tab = (index: number) => Math.min(active, count - 1) === index ? 0 : -1;
	let toolbarKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		let step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
		let target = event.key === "Home" ? 0 : event.key === "End" ? count - 1 : undefined;
		if (!step && target === undefined) return;
		let buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
		let current = buttons.indexOf(document.activeElement as HTMLButtonElement);
		if (current < 0) return;
		event.preventDefault();
		let next = target ?? (current + step + buttons.length) % buttons.length;
		setActive(next);
		buttons[next]?.focus();
	};

	let copy = (which: Which) => {
		setCopying(which);
		copyToClipboard(which === "markdown" ? markdown : actions.current.plain());
	};
	// Tab moves through the picker's field, tabs, grid and skin tone, and closes it past either end.
	let pickerKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key !== "Tab") return;
		let stops = [
			...event.currentTarget.querySelectorAll<HTMLElement>(
				"input, button[tabindex='0'], button:not([tabindex])",
			),
		];
		let at = stops.indexOf(document.activeElement as HTMLElement);
		if (at === -1 || (event.shiftKey ? at === 0 : at === stops.length - 1)) closePicker();
	};

	let items: MessageActionItem[] = reactable
		? [
			...QUICK_REACTIONS.map((item, index): MessageActionItem => ({
				key: item.emoji,
				label: item.label,
				pressed: reacted.has(item.emoji),
				onClick: () => {
					actions.current.react(item.emoji, !reacted.has(item.emoji));
					setPinned(false);
				},
				buttonProps: {
					"data-tooltip": item.label,
					"data-tooltip-verbatim": "",
					onFocus: () => setActive(index),
					tabIndex: tab(index),
				} as MessageActionItem["buttonProps"],
				children: <span aria-hidden="true" className="message-actions-emoji">{item.emoji}</span>,
			})),
			{
				key: "add-reaction",
				label: "Add reaction",
				onClick: () => {
					setMenuOpen(false);
					setPickerOpen(open => !open);
				},
				buttonProps: {
					"aria-controls": pickerOpen ? pickerId : undefined,
					"aria-expanded": pickerOpen,
					"aria-haspopup": "dialog",
					"data-tooltip": "Add reaction",
					onFocus: () => setActive(QUICK_REACTIONS.length),
					ref: addButton,
					tabIndex: tab(QUICK_REACTIONS.length),
				} as MessageActionItem["buttonProps"],
				children: <ReactionAddIcon aria-hidden="true" />,
			},
		]
		: [];
	if (thread) {
		items.push({
			key: "thread",
			label: "Reply in thread",
			onClick: () => {
				setPinned(false);
				actions.current.thread();
			},
			buttonProps: {
				"data-thread-trigger": thread,
				"data-tooltip": "Reply in thread",
				onFocus: () => setActive(reply),
				tabIndex: tab(reply),
			} as MessageActionItem["buttonProps"],
			children: <MessageIcon aria-hidden="true" />,
		});
	}

	return (
		<>
			<DropdownMenu
				modal={false}
				onOpenChange={(next, details) => {
					if (next) {
						setPickerOpen(false);
						setCopying(undefined);
					} else if (details.reason === "outside-press") {
						setPinned(false);
					}
					setMenuOpen(next);
				}}
				open={menuOpen}
			>
				<MessageActions
					aria-label="Reactions and actions"
					aria-orientation="horizontal"
					className="chat-message-toolbar"
					items={items}
					moreProps={{
						"aria-label": "Message actions",
						"data-tooltip": "Message actions",
						onFocus: () => setActive(count - 1),
						ref: moreButton,
						tabIndex: tab(count - 1),
					} as Record<string, unknown>}
					onKeyDown={toolbarKeyDown}
					renderMore={button => (
						<DropdownMenuTrigger
							render={cloneElement(button, {}, <EllipsisVerticalIcon aria-hidden="true" />)}
							tabIndex={tab(count - 1)}
						/>
					)}
					role="toolbar"
				/>
				{menuOpen && (
					<DropdownMenuContent
						align="end"
						aria-label="Message actions"
						className="chat-message-menu w-max"
					>
						<DropdownMenuItem closeOnClick={false} onClick={() => copy("markdown")}>
							<CopyMenuIcon copied={isCopied && copying === "markdown"} />
							{isCopied && copying === "markdown"
								? "Copied"
								: isFailed && copying === "markdown"
								? "Couldn't copy"
								: "Copy"}
						</DropdownMenuItem>
						<DropdownMenuItem closeOnClick={false} onClick={() => copy("plain")}>
							<CopyMenuIcon copied={isCopied && copying === "plain"} />
							{isCopied && copying === "plain"
								? "Copied"
								: isFailed && copying === "plain"
								? "Couldn't copy"
								: "Copy as plain text"}
						</DropdownMenuItem>
						{canRetry && (
							<DropdownMenuItem
								onClick={() => {
									setPinned(false);
									actions.current.retry();
								}}
							>
								<RestartIcon aria-hidden="true" />
								Try again
							</DropdownMenuItem>
						)}
						{canDelete && <DropdownMenuSeparator />}
						{canDelete && (
							<DropdownMenuItem
								onClick={() => {
									setPinned(false);
									actions.current.delete();
								}}
								variant="destructive"
							>
								<CloseIcon aria-hidden="true" />
								Delete
							</DropdownMenuItem>
						)}
					</DropdownMenuContent>
				)}
			</DropdownMenu>
			<span aria-atomic="true" aria-live="polite" className="sr-only" role="status">
				{isCopied ? "Copied" : isFailed ? "Couldn't copy" : ""}
			</span>
			{pickerOpen && createPortal(
				<div
					className="chat-message-picker"
					data-sheet={pickerPosition?.bottom === 0 ? "" : undefined}
					onKeyDownCapture={pickerKeyDown}
					ref={picker}
					style={pickerPosition ?? { visibility: "hidden" }}
				>
					<Suspense fallback={<p className="sr-only" role="status">Loading emoji</p>}>
						<EmojiPicker
							id={pickerId}
							onPick={emoji => {
								actions.current.react(emoji, true);
								closePicker(true);
								setPinned(false);
							}}
						/>
					</Suspense>
				</div>,
				document.body,
			)}
		</>
	);
}, sameToolbar);
