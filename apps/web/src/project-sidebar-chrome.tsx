import panelIcon from "./assets/icons/panel-close.svg";
import { IconButton } from "./icon-button";

import type { RefObject } from "react";
import type * as Api from "./api";

export const SIDEBAR_MIN = 250;
export const SIDEBAR_MAX = 400;
export const SIDEBAR_STORAGE_KEY = "chopin:pane:projects";

export function ProjectSidebarSkeleton() {
	return (
		<div className="project-sidebar-skeleton">
			{[55, 40, 65, 45].map(width => <span key={width} style={{ width: `${width}%` }} />)}
		</div>
	);
}

export function ProjectSidebarLoading(
	{ onCollapse, user }: { onCollapse: () => void; user: Api.User },
) {
	return (
		<aside aria-label="Projects" className="project-sidebar" data-tooltip-edge="">
			<div className="project-sidebar-chrome-fade flex min-h-0 flex-1 flex-col">
				<div className="min-h-0 flex-1 overflow-y-auto">
					<header className="project-sidebar-header">
						<div className="flex items-center gap-2">
							<span className="size-3.5 shrink-0" />
							<span className="text-xs font-semibold text-brand">Chopin</span>
						</div>
						<IconButton
							aria-label="Hide sidebar"
							glyph="default"
							onClick={onCollapse}
							placement="sidebar"
							size="compact"
						>
							<img alt="" height="14" src={panelIcon} width="14" />
						</IconButton>
					</header>
					<p className="sr-only" role="status">Loading projects…</p>
					<div aria-hidden="true" className="pointer-events-none">
						<div className="project-sidebar-primary-actions">
							<div className="project-sidebar-primary-action">
								<span className="size-3.5 shrink-0" />
								<span>Loading projects…</span>
							</div>
							<div className="project-sidebar-primary-action">
								<span className="size-3.5 shrink-0" />
								<span>Search</span>
							</div>
						</div>
						<div className="px-2 py-2">
							<div className="project-sidebar-projects-heading">
								<span>Projects</span>
							</div>
							<ProjectSidebarSkeleton />
						</div>
					</div>
				</div>
				<div aria-hidden="true" className="project-sidebar-footer-actions pointer-events-none">
					<div className="project-sidebar-primary-action">
						<span className="size-3.5 shrink-0" />
						<span>Archived</span>
					</div>
				</div>
				<div aria-hidden="true" className="project-sidebar-account-wrap pointer-events-none">
					<div className="project-sidebar-account">
						{user.avatarUrl
							? (
								<img
									alt=""
									className="size-3.5 rounded-full"
									height={14}
									src={user.avatarUrl}
									width={14}
								/>
							)
							: <span className="size-3.5 rounded-full bg-gray-300" />}
						<span className="truncate">{user.login}</span>
					</div>
				</div>
			</div>
		</aside>
	);
}

export function ProjectSidebarExpandButton(
	{
		buttonRef,
		onExpand,
		shortcut,
	}: {
		buttonRef?: RefObject<HTMLButtonElement | null>;
		onExpand: () => void;
		shortcut?: string;
	},
) {
	return (
		<button
			aria-label="Show sidebar"
			className="project-sidebar-expand btn btn-icon btn-ghost shrink-0"
			data-tooltip="Show sidebar"
			data-tooltip-shortcut={shortcut}
			onClick={onExpand}
			ref={buttonRef}
			type="button"
		>
			<img alt="" className="rotate-180" height="14" src={panelIcon} width="14" />
		</button>
	);
}
