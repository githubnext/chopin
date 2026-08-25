import addProjectIcon from "./assets/figma/navigation/add-project.svg";
import bookBookmarkIcon from "./assets/figma/navigation/book-bookmark.svg";
import boxArchiveIcon from "./assets/figma/navigation/box-archive.svg";
import chopinIcon from "./assets/figma/navigation/chopin.svg";
import collapseIcon from "./assets/figma/navigation/collapse.svg";
import documentActionsIcon from "./assets/figma/navigation/document-actions.svg";
import newDocumentIcon from "./assets/figma/navigation/new-document.svg";
import searchIcon from "./assets/figma/navigation/search.svg";
import { DocumentActionsMenu } from "./document-actions-menu";
import { motionContract } from "./motion-contract";
import { motionImmediately } from "./motion-input";
import { canManageProject } from "./navigation-model";
import { MotionDisclosure } from "@chopin/editor";
import { documentPath, researchWorkspacePath } from "@chopin/protocol/document-url";

import { useId, useRef, useState } from "react";
import type * as Api from "./api";
import type { DocumentAction } from "./document-actions-menu";
import type { ProjectDocuments } from "./document-actions";
import type { ReactNode } from "react";
import type { ResearchChannelGroup } from "./research-navigation";

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

export function newestResearchFirst(
	workspaces: ResearchChannelGroup["workspaces"],
): ResearchChannelGroup["workspaces"] {
	return [...workspaces].sort((first, second) =>
		second.createdAt.localeCompare(first.createdAt) || second.id.localeCompare(first.id)
	);
}

function Project(
	{
		archiveMode,
		creatingProjectIds,
		currentDocumentId,
		currentResearchWorkspaceId,
		entry,
		expanded,
		onCreateDocument,
		onDocumentAction,
		onLoadMore,
		onNewResearch,
		research,
		onToggle,
	}: {
		archiveMode: boolean;
		creatingProjectIds: ReadonlySet<string>;
		currentDocumentId?: string;
		currentResearchWorkspaceId?: string;
		entry: ProjectDocuments;
		expanded: boolean;
		onCreateDocument: (project: Api.NavigationProject) => void;
		onDocumentAction: (channel: Api.Channel, action: DocumentAction) => void;
		onLoadMore: (entry: ProjectDocuments) => void;
		onNewResearch?: (channel: Api.Channel) => void;
		research: ReadonlyMap<string, ResearchChannelGroup>;
		onToggle: () => void;
	},
) {
	let { documents, project } = entry;
	let channels = documents.channels.filter(channel =>
		archiveMode ? channel.archivedAt !== undefined : channel.archivedAt === undefined
	);
	let label = project.repository?.name ?? project.repositoryName;
	let canManage = canManageProject(project);
	let creating = creatingProjectIds.has(project.repositoryId);
	let contentId = useId();
	let collapseMotion = motionContract("collapse");
	let projectContent = (
		<>
			{documents.status === "unavailable" && (
				<p className="project-sidebar-status" role="status">Access unavailable</p>
			)}
			{documents.status === "error" && (
				<p className="project-sidebar-status" role="status">{documents.message}</p>
			)}
			{documents.status === "loading" && channels.length === 0 && (
				<p className="project-sidebar-status" role="status">Loading documents…</p>
			)}
			{channels.length > 0 && (
				<ul className="project-sidebar-documents">
					{channels.map(channel => {
						let children = newestResearchFirst(research.get(channel.id)?.workspaces ?? []);
						let parentCurrent = currentDocumentId === channel.id;
						let researchCurrent = parentCurrent && currentResearchWorkspaceId !== undefined;
						let parentHref = documentPath(
							channel.repositoryOwner,
							channel.repositoryName,
							channel.slug,
						);
						return (
							<li className="group/document" key={channel.id}>
								<div
									className={`project-sidebar-document ${
										parentCurrent && !researchCurrent
											? "project-sidebar-document-current"
											: researchCurrent
											? "project-sidebar-document-ancestor"
											: ""
									}`}
								>
									<a
										aria-current={parentCurrent && !researchCurrent ? "page" : undefined}
										className="project-sidebar-document-link min-w-0 flex-1 text-left text-sm font-medium"
										href={parentHref}
									>
										<span className="min-w-0 flex-1">
											<span className="block truncate">{channel.title}</span>
											{channel.description && (
												<span className="block truncate font-normal text-text-quaternary">
													{channel.description}
												</span>
											)}
										</span>
									</a>
									{canManage && (
										<div className="project-sidebar-document-actions">
											{onNewResearch && !channel.archivedAt && (
												<button
													aria-label={`New research in ${channel.title}`}
													className="project-sidebar-document-action"
													onClick={() => onNewResearch(channel)}
													type="button"
												>
													<NavigationIcon className="h-auto w-3.5" src={searchIcon} />
												</button>
											)}
											<DocumentActionsMenu
												channel={channel}
												className="project-sidebar-document-action"
												onAction={action => onDocumentAction(channel, action)}
												trigger={
													<NavigationIcon className="h-auto w-3.5" src={documentActionsIcon} />
												}
											/>
										</div>
									)}
								</div>
								{children.length > 0 && (
									<ul className="project-sidebar-research">
										{children.map(workspace => (
											<li key={workspace.id}>
												<a
													aria-current={parentCurrent
															&& currentResearchWorkspaceId === workspace.id
														? "page"
														: undefined}
													className={`project-sidebar-research-link ${
														parentCurrent && currentResearchWorkspaceId === workspace.id
															? "project-sidebar-research-current"
															: ""
													}`}
													href={researchWorkspacePath(
														channel.repositoryOwner,
														channel.repositoryName,
														channel.slug,
														workspace.id,
													)}
												>
													{workspace.title}
												</a>
											</li>
										))}
									</ul>
								)}
							</li>
						);
					})}
				</ul>
			)}
			{documents.status === "loading" && channels.length > 0 && (
				<p className="project-sidebar-status" role="status">Loading more…</p>
			)}
			{documents.status === "ready" && documents.nextCursor && (
				<button
					aria-label={`Load more documents in ${label}`}
					className="project-sidebar-load-more"
					onClick={() => onLoadMore(entry)}
					type="button"
				>
					Load more
				</button>
			)}
		</>
	);
	return (
		<li
			className="project-sidebar-project group/project"
			data-project-id={project.repositoryId}
			tabIndex={-1}
		>
			<div className="project-sidebar-project-row">
				<button
					aria-controls={contentId}
					aria-expanded={expanded}
					className="project-sidebar-project-disclosure flex min-w-0 flex-1 items-center gap-2 text-left"
					onClick={onToggle}
					type="button"
				>
					<NavigationIcon className="opacity-50" src={bookBookmarkIcon} />
					<span className="truncate text-sm font-bold">{label}</span>
				</button>
				{!archiveMode && project.available && canManage && (
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
			<MotionDisclosure
				id={contentId}
				immediately={motionImmediately()}
				motion={collapseMotion}
				open={expanded}
				surface="projects"
			>
				<div className="project-sidebar-project-content">{projectContent}</div>
			</MotionDisclosure>
		</li>
	);
}

export function ProjectSidebar(
	{
		accountMenu,
		accountMenuOpen,
		canCreateDocument,
		creatingNewDocument,
		creatingProjectIds,
		currentDocumentId,
		currentResearchWorkspaceId,
		onAccount,
		onAddProject,
		onCollapse,
		onCreateDocument,
		onDocumentAction,
		onLoadMore,
		onNewResearch,
		onNewDocument,
		onSearch,
		onCatalogueModeChange,
		projects,
		research = new Map(),
		catalogueMode,
		user,
	}: {
		accountMenu?: ReactNode;
		accountMenuOpen?: boolean;
		canCreateDocument: boolean;
		catalogueMode: "active" | "archived";
		creatingNewDocument: boolean;
		creatingProjectIds: ReadonlySet<string>;
		currentDocumentId?: string;
		currentResearchWorkspaceId?: string;
		onAccount: () => void;
		onAddProject: () => void;
		onCollapse: () => void;
		onCreateDocument: (project: Api.NavigationProject) => void;
		onDocumentAction: (channel: Api.Channel, action: DocumentAction) => void;
		onLoadMore: (entry: ProjectDocuments) => void;
		onNewResearch?: (channel: Api.Channel) => void;
		onNewDocument: () => void;
		onSearch: () => void;
		onCatalogueModeChange: (mode: "active" | "archived") => void;
		projects: ProjectDocuments[];
		research?: ReadonlyMap<string, ResearchChannelGroup>;
		user: Api.User;
	},
) {
	let [collapsedProjectIds, setCollapsedProjectIds] = useState<ReadonlySet<string>>(
		() => new Set(),
	);
	let archivedChats = useRef<HTMLButtonElement>(null);
	let backToActiveDocs = useRef<HTMLButtonElement>(null);
	let archiveMode = catalogueMode === "archived";
	let primaryActions = (
		<div className="project-sidebar-primary-actions">
			{archiveMode
				? (
					<button
						className="project-sidebar-primary-action"
						onClick={() => {
							onCatalogueModeChange("active");
							requestAnimationFrame(() => archivedChats.current?.focus({ preventScroll: true }));
						}}
						ref={backToActiveDocs}
						type="button"
					>
						<span aria-hidden="true">←</span>
						<span>Back to active docs</span>
					</button>
				)
				: (
					<>
						<button
							className="project-sidebar-primary-action"
							disabled={!canCreateDocument || creatingNewDocument}
							onClick={onNewDocument}
							type="button"
						>
							<NavigationIcon src={newDocumentIcon} />
							<span>New document</span>
						</button>
						<button
							className="project-sidebar-primary-action"
							onClick={onSearch}
							type="button"
						>
							<NavigationIcon src={searchIcon} />
							<span>Search</span>
						</button>
					</>
				)}
		</div>
	);
	let archiveFooter = !archiveMode
		? (
			<div className="project-sidebar-footer-actions">
				<button
					className="project-sidebar-primary-action"
					onClick={() => {
						onCatalogueModeChange("archived");
						requestAnimationFrame(() => backToActiveDocs.current?.focus({ preventScroll: true }));
					}}
					ref={archivedChats}
					type="button"
				>
					<NavigationIcon src={boxArchiveIcon} />
					<span>Archived chats</span>
				</button>
			</div>
		)
		: null;
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

				{primaryActions}

				<nav className="px-2 py-2" aria-label="Projects">
					<div className="project-sidebar-projects-heading group/projects-heading">
						<span>Projects</span>
						{!archiveMode && (
							<button
								aria-label="Add Project"
								className="project-sidebar-action"
								onClick={onAddProject}
								type="button"
							>
								<NavigationIcon className="size-3.5" src={addProjectIcon} />
							</button>
						)}
					</div>
					<ul className="project-sidebar-projects gap-2">
						{[...projects].sort((first, second) => first.project.position - second.project.position)
							.map(entry => (
								<Project
									archiveMode={archiveMode}
									creatingProjectIds={creatingProjectIds}
									currentDocumentId={currentDocumentId}
									currentResearchWorkspaceId={currentResearchWorkspaceId}
									entry={entry}
									expanded={!collapsedProjectIds.has(entry.project.repositoryId)}
									key={entry.project.repositoryId}
									onCreateDocument={onCreateDocument}
									onDocumentAction={onDocumentAction}
									onLoadMore={onLoadMore}
									onNewResearch={archiveMode ? undefined : onNewResearch}
									research={research}
									onToggle={() =>
										setCollapsedProjectIds(current =>
											toggleCollapsedProjectIds(current, entry.project.repositoryId)
										)}
								/>
							))}
					</ul>
				</nav>
			</div>
			{archiveFooter}
			<div className="project-sidebar-account-wrap">
				{accountMenu}
				<button
					className="project-sidebar-account"
					aria-expanded={accountMenuOpen ?? !!accountMenu}
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
