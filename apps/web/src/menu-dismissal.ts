import { usePopoverDismissal } from "@chopin/editor/popover-dismissal";

import type { RefObject } from "react";

export function useMenuDismissal(
	open: boolean,
	regions: RefObject<Node | null>[],
	close: (restoreFocus: boolean) => void,
) {
	usePopoverDismissal(
		open,
		() => regions.map(region => region.current),
		reason => close(reason === "escape"),
	);
}
