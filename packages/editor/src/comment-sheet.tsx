import { useEffect, useRef, useState } from "react";
import { Drawer } from "@base-ui/react/drawer";

import { currentViewport, listenToViewportChanges } from "@chopin/viewport";

import type { ReactNode } from "react";

export const COMMENT_SHEET_SNAP_POINTS = [0.55, 0.92] as const;
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

export function commentSheetTop(viewportHeight: number): number {
	return viewportHeight * (1 - COMMENT_SHEET_SNAP_POINTS[0]);
}

export function nextCommentSheetSnapPoint(current: number): number {
	return current === COMMENT_SHEET_SNAP_POINTS[0]
		? COMMENT_SHEET_SNAP_POINTS[1]
		: COMMENT_SHEET_SNAP_POINTS[0];
}

export type CommentSheetProps = {
	children: ReactNode;
	id: string;
	label: string;
	onClose: () => void;
};

export function CommentSheet({ children, id, label, onClose }: CommentSheetProps) {
	let [open, setOpen] = useState(false);
	let [snapPoint, setSnapPoint] = useState<number | string | null>(
		COMMENT_SHEET_SNAP_POINTS[0],
	);
	let viewportRef = useRef<HTMLDivElement>(null);

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
				setSnapPoint(COMMENT_SHEET_SNAP_POINTS[1]);
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
			onSnapPointChange={setSnapPoint}
			open={open}
			snapPoint={snapPoint}
			snapPoints={[...COMMENT_SHEET_SNAP_POINTS]}
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
							data-plan-comment-sheet
							finalFocus={false}
							id={id}
							initialFocus
						>
							<button
								aria-label="Resize comment sheet"
								className="plan-comment-sheet-grabber"
								onClick={() => {
									let current = typeof snapPoint === "number"
										? snapPoint
										: COMMENT_SHEET_SNAP_POINTS[0];
									setSnapPoint(nextCommentSheetSnapPoint(current));
								}}
								type="button"
							>
								<span aria-hidden="true" />
							</button>
							<Drawer.Title className="sr-only">{label}</Drawer.Title>
							<Drawer.Content
								className="plan-comment-sheet-content"
								data-base-ui-swipe-ignore
							>
								{children}
								<Drawer.Close
									aria-label="Close comment"
									className="sr-only"
									tabIndex={-1}
								/>
							</Drawer.Content>
						</Drawer.Popup>
					</Drawer.Viewport>
				</Drawer.Portal>
			</Drawer.VirtualKeyboardProvider>
		</Drawer.Root>
	);
}
