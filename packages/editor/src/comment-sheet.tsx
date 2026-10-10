import { useEffect, useRef, useState } from "react";
import { Drawer } from "@base-ui/react/drawer";
import { ChevronIcon, CloseIcon } from "@chopin/icons";

import type { ReactNode } from "react";

/** The tallest the sheet grows, as a fraction of the space above the keyboard. */
export const COMMENT_SHEET_LARGE = 0.92;
export const COMMENT_SHEET_MAX_WIDTH = 430;

export function usesCommentSheet({
	coarse,
	width,
}: {
	coarse: boolean;
	width: number;
}): boolean {
	return coarse && width <= COMMENT_SHEET_MAX_WIDTH;
}

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
	| { kind: "back"; count: number }
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
			if (input.siblings > 1) return { kind: "back", count: input.siblings };
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
	/** A draft focuses its field; everything else focuses the close, so no keyboard springs up. */
	focus?: "field" | "close";
};

export function CommentSheet(
	{ children, focus = "close", heading, id, label, onBack, onClose }: CommentSheetProps,
) {
	let [open, setOpen] = useState(false);
	let popup = useRef<HTMLDivElement>(null);
	let close = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		let frame = requestAnimationFrame(() => setOpen(true));
		return () => cancelAnimationFrame(frame);
	}, []);

	return (
		<Drawer.Root
			onOpenChange={setOpen}
			onOpenChangeComplete={next => {
				if (!next) onClose();
			}}
			open={open}
		>
			<Drawer.VirtualKeyboardProvider>
				<Drawer.Portal>
					<Drawer.Backdrop
						className="plan-comment-sheet-backdrop"
						data-plan-comment-sheet-backdrop
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
							ref={popup}
						>
							<span aria-hidden="true" className="plan-comment-sheet-grabber" />
							<Drawer.Title className="sr-only">{label}</Drawer.Title>
							<div className="plan-comment-sheet-head">
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
