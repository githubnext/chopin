import { currentViewport, listenToViewportChanges } from "@chopin/viewport";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import type { CSSProperties } from "react";

type Position = Pick<
	CSSProperties,
	"height" | "left" | "maxHeight" | "top" | "transformOrigin" | "visibility" | "width"
>;

/** Shared portal geometry, focus, and dismissal for header picker controls. */
export function useAnchoredPicker(
	open: boolean,
	setOpen: (open: boolean) => void,
	contentKey: unknown,
) {
	let trigger = useRef<HTMLButtonElement>(null);
	let panel = useRef<HTMLDivElement>(null);
	let search = useRef<HTMLInputElement>(null);
	let [position, setPosition] = useState<Position>({ visibility: "hidden" });

	useLayoutEffect(() => {
		if (!open) return;
		function place() {
			let rect = trigger.current?.getBoundingClientRect();
			if (!rect) return;
			let viewport = currentViewport();
			let margin = 8;
			let gap = 4;
			let topEdge = viewport.top + margin;
			let bottomEdge = viewport.top + viewport.height - margin;
			let width = Math.max(0, Math.min(360, viewport.width - margin * 2));
			let left = Math.max(
				viewport.left + margin,
				Math.min(rect.left, viewport.left + viewport.width - width - margin),
			);
			let above = Math.max(0, Math.min(rect.top - gap, bottomEdge) - topEdge);
			let below = Math.max(0, bottomEdge - Math.max(rect.bottom + gap, topEdge));
			let useAbove = above > below;
			let previousHeight = panel.current?.style.height;
			let previousMaxHeight = panel.current?.style.maxHeight;
			if (panel.current) {
				panel.current.style.height = "auto";
				panel.current.style.maxHeight = "none";
			}
			let naturalHeight = panel.current?.scrollHeight ?? 0;
			if (panel.current) {
				panel.current.style.height = previousHeight ?? "";
				panel.current.style.maxHeight = previousMaxHeight ?? "";
			}
			let maxHeight = Math.min(naturalHeight, useAbove ? above : below);
			let wantedTop = useAbove ? rect.top - gap - maxHeight : rect.bottom + gap;
			setPosition({
				height: maxHeight,
				left,
				maxHeight,
				top: Math.max(topEdge, Math.min(wantedTop, bottomEdge - maxHeight)),
				transformOrigin: useAbove ? "bottom left" : "top left",
				visibility: "visible",
				width,
			});
		}
		function placeForViewportChange(event?: Event) {
			let target = event?.target;
			if (target instanceof Node && panel.current?.contains(target)) return;
			place();
		}
		place();
		return listenToViewportChanges(placeForViewportChange, { observeDocumentScroll: true });
	}, [contentKey, open]);

	useEffect(() => {
		if (!open) return;
		let frame = requestAnimationFrame(() => {
			if (!panel.current?.contains(document.activeElement)) search.current?.focus();
		});
		return () => cancelAnimationFrame(frame);
	}, [open]);

	useEffect(() => {
		if (!open) return;
		function closeOnPointer(event: PointerEvent) {
			let target = event.target;
			if (!(target instanceof Node)) return;
			if (!trigger.current?.contains(target) && !panel.current?.contains(target)) setOpen(false);
		}
		function closeOnFocus(event: FocusEvent) {
			let target = event.target;
			if (!(target instanceof Node)) return;
			if (!trigger.current?.contains(target) && !panel.current?.contains(target)) setOpen(false);
		}
		function closeOnEscape(event: KeyboardEvent) {
			if (event.key !== "Escape") return;
			event.preventDefault();
			setOpen(false);
			trigger.current?.focus();
		}
		document.addEventListener("pointerdown", closeOnPointer);
		document.addEventListener("focusin", closeOnFocus);
		document.addEventListener("keydown", closeOnEscape);
		return () => {
			document.removeEventListener("pointerdown", closeOnPointer);
			document.removeEventListener("focusin", closeOnFocus);
			document.removeEventListener("keydown", closeOnEscape);
		};
	}, [open, setOpen]);

	return { panel, position, search, trigger };
}
