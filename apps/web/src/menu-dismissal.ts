import { useEffect } from "react";

import type { RefObject } from "react";

export function useMenuDismissal(
	open: boolean,
	regions: RefObject<Node | null>[],
	close: (restoreFocus: boolean) => void,
) {
	useEffect(() => {
		if (!open) return;
		let outside = (event: Event) => {
			let target = event.target;
			if (target instanceof Node && !regions.some(region => region.current?.contains(target))) {
				close(false);
			}
		};
		let escape = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			event.stopPropagation();
			close(true);
		};
		document.addEventListener("pointerdown", outside);
		document.addEventListener("focusin", outside);
		document.addEventListener("keydown", escape, true);
		return () => {
			document.removeEventListener("pointerdown", outside);
			document.removeEventListener("focusin", outside);
			document.removeEventListener("keydown", escape, true);
		};
		// `regions` is deliberately omitted: callers pass a fresh array of stable refs each render.
	}, [close, open]);
}
