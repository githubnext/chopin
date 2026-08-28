import sidebarOpenIcon from "./assets/figma/navigation/sidebar-right-3-hide.svg";

import type { RefObject } from "react";

export const SIDEBAR_MIN = 250;
export const SIDEBAR_MAX = 400;
export const SIDEBAR_STORAGE_KEY = "chopin:pane:projects";

export function ProjectSidebarExpandButton(
	{
		buttonRef,
		onExpand,
	}: {
		buttonRef?: RefObject<HTMLButtonElement | null>;
		onExpand: () => void;
	},
) {
	return (
		<button
			aria-label="Open Projects sidebar"
			className="project-sidebar-expand btn btn-icon btn-ghost shrink-0"
			onClick={onExpand}
			ref={buttonRef}
			type="button"
		>
			<img alt="" height="14" src={sidebarOpenIcon} width="14" />
		</button>
	);
}
