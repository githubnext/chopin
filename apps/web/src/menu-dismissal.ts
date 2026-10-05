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
			close(true);
		};
		document.addEventListener("pointerdown", outside);
		document.addEventListener("focusin", outside);
		document.addEventListener("keydown", escape);
		return () => {
			document.removeEventListener("pointerdown", outside);
			document.removeEventListener("focusin", outside);
			document.removeEventListener("keydown", escape);
		};
	}, [close, open]); // refs are stable
}
