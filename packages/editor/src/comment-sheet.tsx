import { useEffect, useRef, useState } from "react";
import { Drawer } from "@base-ui/react/drawer";
import { ChevronIcon, CloseIcon } from "@chopin/icons";
import { currentViewport, listenToViewportChanges } from "@chopin/viewport";

import type { ReactNode } from "react";

/** The tallest the sheet grows, as a fraction of the space above the keyboard. */
export const COMMENT_SHEET_LARGE = 0.92;
/** Where the sheet opens, as a fraction of the space above the keyboard, so its passage shows above it. */
export const COMMENT_SHEET_MEDIUM = 0.5;

/** How much of a sheet's scrolling notes the medium detent keeps in view beneath its header. */
export const COMMENT_SHEET_PEEK = 64;

/**
 * The medium detent's height in pixels of the space the keyboard leaves: half
 * of it, but never less than the header, a peek of the notes and the composer
 * need, and never past the large detent.
 */
export function commentSheetMedium(availableHeight: number, floor = 0): number {
	if (!(availableHeight > 0)) return 0;
	let half = availableHeight * COMMENT_SHEET_MEDIUM;
	return Math.round(Math.min(Math.max(half, floor), availableHeight * COMMENT_SHEET_LARGE));
}

/** What a sheet's medium detent must show: everything but the part of its notes that scrolls. */
function sheetFloor(popup: HTMLElement): number {
	let scroller = popup.querySelector<HTMLElement>(".plan-comment-thread-scroll");
	let content = popup.querySelector<HTMLElement>(".plan-comment-sheet-content");
	// A draft is header and composer only, and shows whole.
	if (!scroller && popup.querySelector("textarea")) return popup.offsetHeight;
	let scrolls = scroller ?? content;
	if (!scrolls) return popup.offsetHeight;
	return popup.offsetHeight - scrolls.offsetHeight
		+ Math.min(scrolls.scrollHeight, COMMENT_SHEET_PEEK);
}

export type CommentSheetDetent = "medium" | "large";

/**
 * How tall the sheet stands: as tall as its content, up to the large detent of
 * the space the keyboard leaves. A taller thread scrolls inside it instead.
 */
export function commentSheetHeight(contentHeight: number, availableHeight: number): number {
	if (!(availableHeight > 0)) return 0;
	let cap = availableHeight * COMMENT_SHEET_LARGE;
	if (!(contentHeight > 0)) return cap;
	return Math.min(cap, contentHeight);
}

/** Where the sheet's top edge sits in the visual viewport, so a passage can stay above it. */
export function commentSheetTop(
	viewport: { top: number; height: number },
	sheetHeight: number,
): number {
	return viewport.top + viewport.height - commentSheetHeight(sheetHeight, viewport.height);
}

/**
 * What one header row says, so no title repeats what the content shows.
 *
 * A thread quotes its passage; a block's list counts its threads; a thread
 * opened from that list leads back to it. Anything else gets a plain title.
 */
export type CommentSheetHeading =
	| { kind: "quote"; quote: string }
	| { kind: "count"; count: number }
	| { kind: "back"; count: number; quote?: string }
	| { kind: "title"; title: string };

export function commentSheetHeading(
	input:
		| { kind: "draft"; quote: string }
		| { kind: "thread"; quote: string; siblings: number }
		| { kind: "list"; count: number }
		| { kind: "other"; title: string },
): CommentSheetHeading {
	switch (input.kind) {
		case "draft":
			return input.quote.trim()
				? { kind: "quote", quote: input.quote }
				: { kind: "title", title: "New comment" };
		case "thread":
			if (input.siblings > 1) {
				// The back row takes the header; the passage stays beneath it for context.
				return input.quote.trim()
					? { kind: "back", count: input.siblings, quote: input.quote }
					: { kind: "back", count: input.siblings };
			}
			return input.quote.trim()
				? { kind: "quote", quote: input.quote }
				: { kind: "title", title: "Comment" };
		case "list":
			return { kind: "count", count: input.count };
		case "other":
			return { kind: "title", title: input.title };
	}
}

export type CommentSheetProps = {
	children: ReactNode;
	id: string;
	label: string;
	heading: CommentSheetHeading;
	/** Leave the thread for its block's list; shown when the heading is `back`. */
	onBack?: () => void;
	onClose: () => void;
	/** The sheet's surface once it is mounted, for anything that keeps clear of it. */
	onSurface?: (element: HTMLDivElement | null) => void;
	/** A draft focuses its field; everything else focuses the close, so no keyboard springs up. */
	focus?: "field" | "close";
	/** Where this thread stands among the document's open threads, to step between them. */
	pager?: CommentSheetPager;
	/** How tall the sheet shows while it rests at the medium detent; undefined when it is large. */
	onDetentHeight?: (height: number | undefined) => void;
	/** What the sheet is showing; another thread opens at the medium detent again. */
	contentKey?: string;
};

export type CommentSheetPager = {
	index: number;
	count: number;
	/** Absent at the first thread: the pager stops at its ends rather than wrapping. */
	onPrevious?: () => void;
	onNext?: () => void;
	/** Show every open thread as a list, from the count between the steps. */
	onList?: () => void;
};

export function CommentSheet(
	{
		children,
		contentKey,
		focus = "close",
		heading,
		id,
		label,
		onBack,
		onClose,
		onDetentHeight,
		onSurface,
		pager,
	}: CommentSheetProps,
) {
	let [open, setOpen] = useState(false);
	let [detent, setDetent] = useState<CommentSheetDetent>("medium");
	let [available, setAvailable] = useState(() => currentViewport().height);
	let [floor, setFloor] = useState(0);
	let medium = commentSheetMedium(available, floor);
	/** Whether the content is taller than the medium detent, so there is a large one to pull up to. */
	let [tall, setTall] = useState(false);
	let [surface, setSurface] = useState<HTMLDivElement | null>(null);
	let popup = useRef<HTMLDivElement>(null);
	let close = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		let frame = requestAnimationFrame(() => setOpen(true));
		return () => cancelAnimationFrame(frame);
	}, []);

	// The medium detent follows the space above the keyboard as it opens and closes.
	useEffect(() => {
		let update = () => setAvailable(currentViewport().height);
		update();
		return listenToViewportChanges(update);
	}, []);

	useEffect(() => {
		let element = surface;
		if (!element) return;
		let measure = () => {
			setFloor(sheetFloor(element));
			setTall(element.offsetHeight > medium + 1);
		};
		measure();
		let observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, [medium, surface]);

	useEffect(() => setDetent("medium"), [contentKey]);

	useEffect(() => {
		onDetentHeight?.(detent === "medium" ? medium : undefined);
	}, [detent, medium, onDetentHeight]);
	useEffect(() => () => onDetentHeight?.(undefined), [onDetentHeight]);

	return (
		<Drawer.Root
			onOpenChange={setOpen}
			onOpenChangeComplete={next => {
				if (!next) onClose();
			}}
			// A sheet shorter than its medium detent has one snap point, which the drawer names
			// as the large one; even a tap on its header settles there. It is still medium.
			onSnapPointChange={point => {
				if (point !== null) setDetent(point === 1 && tall ? "large" : "medium");
			}}
			open={open}
			snapPoint={detent === "large" ? 1 : medium}
			// Pixels above 1, a fraction at 1: the large detent is as tall as the content allows.
			snapPoints={medium > 1 ? [medium, 1] : [1]}
		>
			<Drawer.VirtualKeyboardProvider>
				<Drawer.Portal>
					<Drawer.Backdrop
						className="plan-comment-sheet-backdrop"
						data-plan-comment-sheet-backdrop
						data-plan-comment-sheet-detents={tall || undefined}
						data-plan-comment-sheet-large={(tall && detent === "large") || undefined}
						onClick={() => setOpen(false)}
					/>
					<Drawer.Viewport className="plan-comment-sheet-viewport">
						<Drawer.Popup
							aria-modal="true"
							className="plan-comment-sheet-popup"
							data-plan-comment-sheet
							finalFocus={false}
							id={id}
							initialFocus={() =>
								(focus === "field"
									? popup.current?.querySelector<HTMLElement>("textarea")
									: undefined) ?? close.current ?? true}
							ref={element => {
								popup.current = element;
								setSurface(element);
								onSurface?.(element);
							}}
						>
							<span aria-hidden="true" className="plan-comment-sheet-grabber" />
							<Drawer.Title className="sr-only">{label}</Drawer.Title>
							<div className="plan-comment-sheet-head">
								{pager && pager.count > 1 && heading.kind !== "back" && (
									<div className="plan-comment-sheet-pager" data-plan-comment-pager="">
										<button
											aria-label="Previous comment"
											className="plan-comment-sheet-step btn btn-icon btn-ghost"
											disabled={!pager.onPrevious}
											onClick={pager.onPrevious}
											type="button"
										>
											<ChevronIcon aria-hidden="true" className="rotate-180" size={16} />
										</button>
										{pager.onList
											? (
												<button
													aria-label={`${pager.index + 1} of ${pager.count}, show all comments`}
													className="plan-comment-sheet-count btn btn-sm btn-ghost"
													data-plan-comment-pager-list=""
													onClick={pager.onList}
													type="button"
												>
													<span aria-live="polite">
														{pager.index + 1} of {pager.count}
													</span>
												</button>
											)
											: <span aria-live="polite">{pager.index + 1} of {pager.count}</span>}
										<button
											aria-label="Next comment"
											className="plan-comment-sheet-step btn btn-icon btn-ghost"
											disabled={!pager.onNext}
											onClick={pager.onNext}
											type="button"
										>
											<ChevronIcon aria-hidden="true" size={16} />
										</button>
									</div>
								)}
								{heading.kind === "quote" && (
									<blockquote className="plan-comment-sheet-quote" data-plan-comment-sheet-quote>
										{heading.quote}
									</blockquote>
								)}
								{heading.kind === "count" && (
									<p className="plan-comment-sheet-heading">{heading.count} comments</p>
								)}
								{heading.kind === "title" && (
									<p className="plan-comment-sheet-heading">{heading.title}</p>
								)}
								{heading.kind === "back" && (
									<button
										className="plan-comment-sheet-back btn btn-md btn-ghost"
										data-plan-comment-back
										onClick={onBack}
										type="button"
									>
										<ChevronIcon aria-hidden="true" className="rotate-180" size={16} />
										All {heading.count} comments
									</button>
								)}
								{heading.kind === "back" && heading.quote && (
									<blockquote className="plan-comment-sheet-quote" data-plan-comment-sheet-quote>
										{heading.quote}
									</blockquote>
								)}
								<Drawer.Close
									aria-label="Close comment"
									className="plan-comment-close plan-comment-sheet-close btn btn-icon btn-ghost"
									ref={close}
									title="Close comment"
								>
									<CloseIcon aria-hidden="true" size={16} />
								</Drawer.Close>
							</div>
							<Drawer.Content
								className="plan-comment-sheet-content"
								data-base-ui-swipe-ignore
							>
								{children}
							</Drawer.Content>
						</Drawer.Popup>
					</Drawer.Viewport>
				</Drawer.Portal>
			</Drawer.VirtualKeyboardProvider>
		</Drawer.Root>
	);
}
