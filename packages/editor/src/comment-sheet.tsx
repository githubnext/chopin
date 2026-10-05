import { useEffect, useRef, useState } from "react";
import { Drawer } from "@base-ui/react/drawer";
import { CloseIcon } from "@chopin/icons";

import { currentViewport, listenToViewportChanges } from "@chopin/viewport";

import type { ReactNode } from "react";

/** The medium detent fits the content between these fractions of the viewport. */
export const COMMENT_SHEET_FIT_RANGE = [0.2, 0.85] as const;
export const COMMENT_SHEET_LARGE = 0.92;
export const COMMENT_SHEET_SNAP_POINTS = [COMMENT_SHEET_FIT_RANGE[1], COMMENT_SHEET_LARGE] as const;
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

export function commentSheetTop(viewportHeight: number, fit: number = 0.55): number {
	return viewportHeight * (1 - fit);
}

/** The medium detent: as tall as the content needs, within the fit range. */
export function commentSheetFitSnapPoint(contentHeight: number, viewportHeight: number): number {
	if (!(viewportHeight > 0) || !(contentHeight > 0)) return COMMENT_SHEET_FIT_RANGE[1];
	return Math.min(
		COMMENT_SHEET_FIT_RANGE[1],
		Math.max(COMMENT_SHEET_FIT_RANGE[0], contentHeight / viewportHeight),
	);
}

export function nextCommentSheetSnapPoint(current: number, fit: number): number {
	return current === fit ? COMMENT_SHEET_LARGE : fit;
}

export type CommentSheetProps = {
	children: ReactNode;
	id: string;
	label: string;
	/** Visible heading; defaults to the accessible label. */
	title?: string;
	onClose: () => void;
	/** Show the close beside the grabber, for content with no header of its own. */
	closeVisible?: boolean;
};

export function CommentSheet(
	{ children, closeVisible, id, label, onClose, title }: CommentSheetProps,
) {
	let [open, setOpen] = useState(false);
	let [large, setLarge] = useState(false);
	let [fit, setFit] = useState<number>(COMMENT_SHEET_FIT_RANGE[1]);
	let snapPoint = large ? COMMENT_SHEET_LARGE : fit;
	let viewportRef = useRef<HTMLDivElement>(null);
	let [content, setContent] = useState<HTMLDivElement | null>(null);
	let [body, setBody] = useState<HTMLDivElement | null>(null);

	useEffect(() => {
		if (!content || !body) return;
		let measure = () => {
			let padding = parseFloat(getComputedStyle(content).paddingBottom) || 0;
			setFit(
				commentSheetFitSnapPoint(
					body.offsetHeight + content.offsetTop + padding,
					currentViewport().height,
				),
			);
		};
		measure();
		let observer = new ResizeObserver(measure);
		observer.observe(body);
		return () => observer.disconnect();
	}, [content, body]);

	useEffect(() => {
		let frame = requestAnimationFrame(() => setOpen(true));
		return () => cancelAnimationFrame(frame);
	}, []);

	useEffect(() => {
		let expandForKeyboard = () => {
			let viewport = currentViewport();
			let keyboardInset = window.innerHeight - viewport.top - viewport.height;
			let active = document.activeElement;
			if (
				keyboardInset > 60
				&& active instanceof HTMLElement
				&& viewportRef.current?.contains(active)
			) {
				setLarge(true);
			}
		};

		return listenToViewportChanges(expandForKeyboard);
	}, []);

	return (
		<Drawer.Root
			onOpenChange={setOpen}
			onOpenChangeComplete={next => {
				if (!next) onClose();
			}}
			onSnapPointChange={next => setLarge(typeof next === "number" && next > fit)}
			open={open}
			snapPoint={snapPoint}
			snapPoints={[fit, COMMENT_SHEET_LARGE]}
			snapToSequentialPoints
		>
			<Drawer.VirtualKeyboardProvider>
				<Drawer.Portal>
					<Drawer.Backdrop
						className="plan-comment-sheet-backdrop"
						data-plan-comment-sheet-backdrop
						onClick={() => setOpen(false)}
					/>
					<Drawer.Viewport className="plan-comment-sheet-viewport" ref={viewportRef}>
						<Drawer.Popup
							aria-modal="true"
							className="plan-comment-sheet-popup"
							data-fit={fit}
							data-plan-comment-sheet
							finalFocus={false}
							id={id}
							initialFocus
						>
							<button
								aria-label="Resize comment sheet"
								className="plan-comment-sheet-grabber"
								data-tooltip="Resize sheet"
								onClick={() => setLarge(nextCommentSheetSnapPoint(snapPoint, fit) > fit)}
								type="button"
							>
								<span aria-hidden="true" />
							</button>
							{closeVisible && (
								<Drawer.Close
									aria-label="Close comment"
									className="plan-comment-close plan-comment-sheet-close btn btn-icon btn-ghost"
									title="Close comment"
								>
									<CloseIcon aria-hidden="true" size={14} />
								</Drawer.Close>
							)}
							<Drawer.Title className="sr-only">{label}</Drawer.Title>
							<div aria-hidden="true" className="plan-comment-sheet-title">
								{title ?? label}
							</div>
							<Drawer.Content
								className="plan-comment-sheet-content"
								data-base-ui-swipe-ignore
								ref={setContent}
							>
								<div ref={setBody}>{children}</div>
								{!closeVisible && (
									<Drawer.Close
										aria-label="Close comment"
										className="sr-only"
										tabIndex={-1}
									/>
								)}
							</Drawer.Content>
						</Drawer.Popup>
					</Drawer.Viewport>
				</Drawer.Portal>
			</Drawer.VirtualKeyboardProvider>
		</Drawer.Root>
	);
}
