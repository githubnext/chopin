import addProjectIcon from "./assets/figma/navigation/add-project.svg";
import bookBookmarkIcon from "./assets/figma/navigation/book-bookmark.svg";
import chopinIcon from "./assets/figma/navigation/chopin.svg";
import collapseIcon from "./assets/figma/navigation/collapse.svg";
import documentActionsIcon from "./assets/figma/navigation/document-actions.svg";
import newDocumentIcon from "./assets/figma/navigation/new-document.svg";
import searchIcon from "./assets/figma/navigation/search.svg";
import sidebarOpenIcon from "./assets/figma/navigation/sidebar-right-3-hide.svg";
import { canEditProject } from "./navigation-model";

import { useState } from "react";
import type * as Api from "./api";
import type { ProjectDocuments } from "./document-actions";
import type { ReactNode } from "react";

export const SIDEBAR_MIN = 250;
export const SIDEBAR_MAX = 400;
export const SIDEBAR_STORAGE_KEY = "chopin:pane:projects";

export function NavigationIcon(
	{ alt = "", className, src }: { alt?: string; className?: string; src: string },
) {
	return <img alt={alt} className={className} height={14} src={src} width={14} />;
}

export function toggleCollapsedProjectIds(
	ids: ReadonlySet<string>,
	repositoryId: string,
): Set<string> {
	let next = new Set(ids);
	if (next.has(repositoryId)) next.delete(repositoryId);
	else next.add(repositoryId);
	return next;
}

function Project(
	{
		creatingProjectIds,
		currentDocumentId,
		entry,
		expanded,
		onCreateDocument,
		onLoadMore,
		onOpenDocument,
		onRenameDocument,
		onToggle,
	}: {
		creatingProjectIds: ReadonlySet<string>;
		currentDocumentId?: string;
		entry: ProjectDocuments;
		expanded: boolean;
		onCreateDocument: (project: Api.NavigationProject) => void;
		onLoadMore: (entry: ProjectDocuments) => void;
		onOpenDocument: (documentId: string) => void;
		onRenameDocument: (channel: Api.Channel) => void;
		onToggle: () => void;
	},
) {
	let { documents, project } = entry;
	let { channels } = documents;
	let label = project.repository?.name ?? project.repositoryName;
	let canEdit = canEditProject(project);
	let creating = creatingProjectIds.has(project.repositoryId);
	return (
		<li
			className="project-sidebar-project group/project"
			data-project-id={project.repositoryId}
			tabIndex={-1}
		>
			<div className="project-sidebar-project-row">
				<button
					aria-expanded={expanded}
					className="project-sidebar-project-disclosure flex min-w-0 flex-1 items-center gap-2 text-left"
					onClick={onToggle}
					type="button"
				>
					<NavigationIcon className="opacity-50" src={bookBookmarkIcon} />
					<span className="truncate text-sm font-bold">{label}</span>
				</button>
				{project.available && canEdit && (
					<button
						aria-label={`New document in ${label}`}
						className="project-sidebar-action"
						disabled={creating}
						onClick={() => onCreateDocument(project)}
						type="button"
					>
						<NavigationIcon src={newDocumentIcon} />
					</button>
				)}
			</div>
			{expanded && documents.status === "unavailable" && (
				<p className="project-sidebar-status" role="status">Access unavailable</p>
			)}
			{expanded && documents.status === "error" && (
				<p className="project-sidebar-status" role="status">{documents.message}</p>
			)}
			{expanded && documents.status === "loading" && channels.length === 0 && (
				<p className="project-sidebar-status" role="status">Loading documents…</p>
			)}
			{expanded && channels.length > 0 && (
				<ul className="project-sidebar-documents">
					{channels.map(channel => (
						<li className="group/document" key={channel.id}>
							<div
								className={`project-sidebar-document ${
									currentDocumentId === channel.id
										? "project-sidebar-document-current"
										: ""
								}`}
							>
								<button
									aria-current={currentDocumentId === channel.id ? "page" : undefined}
									className="min-w-0 flex-1 truncate text-left text-sm font-medium"
									onClick={() => onOpenDocument(channel.id)}
									type="button"
								>
									{channel.title}
								</button>
								{canEdit && (
									<button
										aria-label={`Rename ${channel.title}`}
										className="project-sidebar-document-action"
										onClick={() => onRenameDocument(channel)}
										type="button"
									>
										<NavigationIcon className="h-auto w-3.5" src={documentActionsIcon} />
									</button>
								)}
							</div>
						</li>
					))}
				</ul>
			)}
			{expanded && documents.status === "loading" && channels.length > 0 && (
				<p className="project-sidebar-status" role="status">Loading more…</p>
			)}
			{expanded && documents.status === "ready" && documents.nextCursor && (
				<button
					aria-label={`Load more documents in ${label}`}
					className="project-sidebar-load-more"
					onClick={() => onLoadMore(entry)}
					type="button"
				>
					Load more
				</button>
			)}
		</li>
	);
}

export function ProjectSidebar(
	{
		accountMenu,
		canCreateDocument,
		creatingNewDocument,
		creatingProjectIds,
		currentDocumentId,
		onAccount,
		onAddProject,
		onCollapse,
		onCreateDocument,
		onLoadMore,
		onNewDocument,
		onOpenDocument,
		onRenameDocument,
		onSearch,
		projects,
		user,
	}: {
		accountMenu?: ReactNode;
		canCreateDocument: boolean;
		creatingNewDocument: boolean;
		creatingProjectIds: ReadonlySet<string>;
		currentDocumentId?: string;
		onAccount: () => void;
		onAddProject: () => void;
		onCollapse: () => void;
		onCreateDocument: (project: Api.NavigationProject) => void;
		onLoadMore: (entry: ProjectDocuments) => void;
		onNewDocument: () => void;
		onOpenDocument: (documentId: string) => void;
		onRenameDocument: (channel: Api.Channel) => void;
		onSearch: () => void;
		projects: ProjectDocuments[];
		user: Api.User;
	},
) {
	let [collapsedProjectIds, setCollapsedProjectIds] = useState<ReadonlySet<string>>(
		() => new Set(),
	);
	return (
		<aside className="project-sidebar" data-project-sidebar="" aria-label="Projects">
			<div className="min-h-0 flex-1 overflow-y-auto">
				<header className="project-sidebar-header group/sidebar-header">
					<div className="flex items-center gap-2">
						<img alt="" height={18} src={chopinIcon} width={18} />
						<span className="text-sm font-semibold text-brand">Chopin</span>
					</div>
					<button
						aria-label="Collapse Projects sidebar"
						className="project-sidebar-action"
						onClick={onCollapse}
						type="button"
					>
						<NavigationIcon src={collapseIcon} />
					</button>
				</header>

				<div className="project-sidebar-primary-actions">
					<button
						className="project-sidebar-primary-action"
						disabled={!canCreateDocument || creatingNewDocument}
						onClick={onNewDocument}
						type="button"
					>
						<NavigationIcon src={newDocumentIcon} />
						<span>New document</span>
					</button>
					<button className="project-sidebar-primary-action" onClick={onSearch} type="button">
						<NavigationIcon src={searchIcon} />
						<span>Search</span>
					</button>
				</div>

				<nav className="px-2 py-2" aria-label="Projects">
					<div className="project-sidebar-projects-heading group/projects-heading">
						<span>Projects</span>
						<button
							aria-label="Add Project"
							className="project-sidebar-action"
							onClick={onAddProject}
							type="button"
						>
							<NavigationIcon className="size-3.5" src={addProjectIcon} />
						</button>
					</div>
					<ul className="project-sidebar-projects gap-2">
						{[...projects].sort((first, second) => first.project.position - second.project.position)
							.map(entry => (
								<Project
									creatingProjectIds={creatingProjectIds}
									currentDocumentId={currentDocumentId}
									entry={entry}
									expanded={!collapsedProjectIds.has(entry.project.repositoryId)}
									key={entry.project.repositoryId}
									onCreateDocument={onCreateDocument}
									onLoadMore={onLoadMore}
									onOpenDocument={onOpenDocument}
									onRenameDocument={onRenameDocument}
									onToggle={() =>
										setCollapsedProjectIds(current =>
											toggleCollapsedProjectIds(current, entry.project.repositoryId)
										)}
								/>
							))}
					</ul>
				</nav>
			</div>
			<div className="project-sidebar-account-wrap">
				{accountMenu}
				<button
					className="project-sidebar-account"
					aria-expanded={!!accountMenu}
					onClick={onAccount}
					type="button"
				>
					{user.avatarUrl
						? (
							<img
								alt=""
								className="size-5 rounded-full"
								height={20}
								src={user.avatarUrl}
								width={20}
							/>
						)
						: <span aria-hidden="true" className="size-5 rounded-full bg-gray-300" />}
					<span className="truncate">{user.login}</span>
				</button>
			</div>
		</aside>
	);
}

export function ProjectSidebarExpandButton({ onExpand }: { onExpand: () => void }) {
	return (
		<button
			aria-label="Open Projects sidebar"
			className="project-sidebar-expand btn btn-icon btn-ghost shrink-0"
			onClick={onExpand}
			type="button"
		>
			<img alt="" height="18" src={sidebarOpenIcon} width="18" />
		</button>
	);
}
