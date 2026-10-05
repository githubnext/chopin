import panelIcon from "./assets/icons/panel-close.svg";

import type { RefObject } from "react";

export const SIDEBAR_MIN = 250;
export const SIDEBAR_MAX = 400;
export const SIDEBAR_STORAGE_KEY = "chopin:pane:projects";

export function ProjectSidebarLoading({ onCollapse }: { onCollapse: () => void }) {
	return (
		<div className="project-sidebar text-sm">
			<div className="project-sidebar-header">
				<p role="status">Loading projects…</p>
				<button
					aria-label="Hide sidebar"
					className="btn btn-icon btn-ghost"
					onClick={onCollapse}
					type="button"
				>
					<img alt="" height="14" src={panelIcon} width="14" />
				</button>
			</div>
		</div>
	);
}

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
			aria-label="Show sidebar"
			className="project-sidebar-expand btn btn-icon btn-ghost shrink-0"
			data-tooltip="Show sidebar"
			onClick={onExpand}
			ref={buttonRef}
			type="button"
		>
			<img alt="" className="rotate-180" height="14" src={panelIcon} width="14" />
		</button>
	);
}
