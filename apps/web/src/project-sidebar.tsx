import addProjectIcon from "./assets/figma/navigation/add-project.svg";
import chopinIcon from "./assets/figma/navigation/chopin.svg";
import collapseIcon from "./assets/icons/panel-close.svg";
import documentActionsIcon from "./assets/figma/navigation/document-actions.svg";
import newDocumentIcon from "./assets/figma/navigation/new-document.svg";
import { DocumentActionsMenu } from "./document-actions-menu";
import { ProjectSidebarSkeleton } from "./project-sidebar-chrome";
import { motionContract } from "./motion-contract";
import { motionImmediately } from "./motion-input";
import { canManageProject } from "./navigation-model";
import { currentShortcutPlatform, shortcutLabel } from "./shortcuts";
import { Face, MotionDisclosure, MotionDisclosureIcon } from "@chopin/editor";
import { childDocumentPath, documentPath } from "@chopin/protocol/document-url";
import { useSidebarRowPresence } from "./sidebar-row-presence";

import { useEffect, useId, useRef, useState } from "react";
import {
	ArchiveIcon,
	ChevronIcon,
	DocumentIcon,
	LockIcon,
	SearchIcon,
	SignInIcon,
} from "@chopin/icons";
import type * as Api from "./api";
import type { DocumentAction } from "./document-actions-menu";
import type { ProjectDocuments } from "./document-actions";
import type { DocumentCreationPhase } from "./use-document-creation";
import type { ReactNode, Ref } from "react";

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

export function documentGroups(
	channels: Api.Channel[],
	archiveMode: boolean,
): Array<{ parent: Api.Channel; children: Api.Channel[] }> {
	let parents = channels.filter(channel =>
		channel.parentChannelId === undefined
		&& (archiveMode ? channel.archivedAt !== undefined : channel.archivedAt === undefined)
	);
	let parentIds = new Set(parents.map(channel => channel.id));
	let children = new Map<string, Api.Channel[]>();
	for (let channel of channels) {
		if (!channel.parentChannelId || !parentIds.has(channel.parentChannelId)) continue;
		let nested = children.get(channel.parentChannelId) ?? [];
		nested.push(channel);
		children.set(channel.parentChannelId, nested);
	}
	return parents.map(parent => ({ parent, children: children.get(parent.id) ?? [] }));
}

function archiveFocusTarget(list: HTMLElement | null, documentId: string): HTMLElement | undefined {
	let row = [...list?.querySelectorAll<HTMLElement>(":scope > li[data-document-id]") ?? []]
		.find(item => item.dataset.documentId === documentId);
	if (!row || !list) return undefined;
	let links = [...list.querySelectorAll<HTMLElement>(
		":scope > li:not([data-exiting]) .project-sidebar-document-link",
	)].filter(link => !row.contains(link));
	return links.find(link => row.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING)
		?? links.at(-1)
		?? row.closest(".project-sidebar-project")?.querySelector<HTMLElement>(
			".project-sidebar-project-disclosure",
		) ?? undefined;
}

// The actions menu is portalled and restores focus to its own trigger, which is
// inside the row being removed, so focus is reclaimed once the menu has settled.
function reclaimFocus(target: HTMLElement) {
	let reclaim = () => {
		let active = document.activeElement;
		if (
			target.isConnected
			&& (!active || active === document.body || active.closest("[data-exiting], [inert]"))
		) target.focus({ preventScroll: true });
	};
	window.setTimeout(reclaim, 0);
	requestAnimationFrame(() => requestAnimationFrame(reclaim));
	window.setTimeout(reclaim, 120);
}

function DocumentRow(
	{ children, documentId, exiting, enter, onExited }: {
		children: ReactNode;
		documentId: string;
		enter: boolean;
		exiting: boolean;
		onExited: () => void;
	},
) {
	let item = useRef<HTMLLIElement>(null);
	let id = useId();
	let motion = motionContract("collapse");
	let [armed, setArmed] = useState(!enter);
	useEffect(() => {
		if (armed) return;
		let frame = requestAnimationFrame(() => setArmed(true));
		return () => cancelAnimationFrame(frame);
	}, [armed]);
	let finished = useRef(onExited);
	finished.current = onExited;
	useEffect(() => {
		if (!exiting) return;
		let timer = window.setTimeout(() => finished.current(), motion.closeDuration + 50);
		return () => window.clearTimeout(timer);
	}, [exiting, motion.closeDuration]);
	return (
		<li
			className="group/document"
			data-document-id={documentId}
			data-exiting={exiting ? "" : undefined}
			ref={item}
		>
			<MotionDisclosure
				id={id}
				immediately={motionImmediately()}
				motion={motion}
				open={armed && !exiting}
				surface="documents"
			>
				{children}
			</MotionDisclosure>
		</li>
	);
}

export function menuItemTarget(key: string, current: number, count: number): number {
	if (key === "Home") return 0;
	if (key === "End") return count - 1;
	return (current + (key === "ArrowDown" ? 1 : -1) + count) % count;
}

function noop() {}

function Project(
	{
		archiveMode,
		pendingCreations,
		currentDocumentId,
		entry,
		expanded,
		focus,
		onCreateDocument,
		onDocumentAction,
		onFocused,
		onLoadMore,
		onToggle,
	}: {
		archiveMode: boolean;
		pendingCreations: ReadonlyMap<string, DocumentCreationPhase>;
		currentDocumentId?: string;
		entry: ProjectDocuments;
		expanded: boolean;
		focus: boolean;
		onCreateDocument: (project: Api.NavigationProject) => void;
		onDocumentAction: (channel: Api.Channel, action: DocumentAction) => void;
		onFocused: () => void;
		onLoadMore: (entry: ProjectDocuments) => void;
		onToggle: () => void;
	},
) {
	let item = useRef<HTMLLIElement>(null);
	let disclosure = useRef<HTMLButtonElement>(null);
	let [flash, setFlash] = useState(false);
	useEffect(() => {
		if (!focus) return;
		disclosure.current?.focus({ preventScroll: true });
		item.current?.scrollIntoView({ block: "nearest" });
		setFlash(true);
		onFocused();
	}, [focus, onFocused]);
	useEffect(() => {
		if (!flash) return;
		let timer = setTimeout(setFlash, 900, false);
		return () => clearTimeout(timer);
	}, [flash]);
	let { documents, project } = entry;
	let groups = documentGroups(documents.channels, archiveMode);
	let presence = useSidebarRowPresence(groups, {
		immediately: motionImmediately(),
		ready: documents.status === "ready",
		scope: archiveMode ? "archived" : "active",
	});
	let label = project.repository?.name ?? project.repositoryName;
	let canManage = canManageProject(project);
	let phase = pendingCreations.get(project.repositoryId);
	let contentId = useId();
	let collapseMotion = motionContract("collapse");
	let list = useRef<HTMLUListElement>(null);
	let documentAction = (channel: Api.Channel, action: DocumentAction) => {
		let target = action === "archive" ? archiveFocusTarget(list.current, channel.id) : undefined;
		onDocumentAction(channel, action);
		if (target) reclaimFocus(target);
	};
	let projectContent = (
		<>
			{documents.status === "ready" && groups.length === 0 && !documents.nextCursor && (
				<p className="project-sidebar-empty">
					{archiveMode ? "No archived documents" : "No documents"}
				</p>
			)}
			{documents.status === "unavailable" && (
				<p className="project-sidebar-status" role="status">Access unavailable</p>
			)}
			{documents.status === "error" && (
				<p className="project-sidebar-status" role="status">{documents.message}</p>
			)}
			{documents.status === "loading" && groups.length === 0 && (
				<p className="project-sidebar-status" role="status">Loading documents…</p>
			)}
			{(groups.length > 0 || presence.rows.length > 0) && (
				<ul className="project-sidebar-documents" ref={list}>
					{presence.rows.map(({ enter, exiting, group: { children, parent: channel } }) => {
						let parentCurrent = currentDocumentId === channel.id;
						let childCurrent = children.some(child =>
							child.id === currentDocumentId
						);
						let parentHref = documentPath(
							channel.repositoryOwner,
							channel.repositoryName,
							channel.slug,
						);
						return (
							<DocumentRow
								documentId={channel.id}
								enter={enter}
								exiting={exiting}
								key={channel.id}
								onExited={() => presence.finish(channel.id)}
							>
								<div
									className={`project-sidebar-document ${
										parentCurrent
											? "project-sidebar-document-current"
											: childCurrent
											? "project-sidebar-document-ancestor"
											: ""
									} ${enter && !parentCurrent ? "project-sidebar-document-new" : ""}`}
								>
									<a
										aria-current={parentCurrent ? "page" : undefined}
										aria-description={channel.description || undefined}
										className="project-sidebar-document-link"
										data-tooltip={channel.description || undefined}
										data-tooltip-side="right"
										data-tooltip-verbatim=""
										href={parentHref}
									>
										<span className="truncate">{channel.title}</span>
									</a>
									{canManage && (
										<div className="project-sidebar-document-actions">
											<DocumentActionsMenu
												channel={channel}
												className="project-sidebar-document-action"
												onAction={action => documentAction(channel, action)}
												trigger={
													<NavigationIcon className="h-auto w-3.5" src={documentActionsIcon} />
												}
											/>
										</div>
									)}
								</div>
								{children.length > 0 && (
									<ul className="project-sidebar-children">
										{children.map(child => {
											let current = child.id === currentDocumentId;
											return (
												<li
													className={`project-sidebar-child group/document ${
														current ? "project-sidebar-child-current" : ""
													}`}
													key={child.id}
												>
													<a
														aria-current={current ? "page" : undefined}
														className="project-sidebar-child-link"
														href={childDocumentPath(
															channel.repositoryOwner,
															channel.repositoryName,
															channel.slug,
															child.slug,
														)}
													>
														<span className="truncate">{child.title}</span>
													</a>
													{canManage && (
														<div className="project-sidebar-document-actions">
															<DocumentActionsMenu
																channel={child}
																className="project-sidebar-document-action"
																onAction={action => onDocumentAction(child, action)}
																trigger={
																	<NavigationIcon
																		className="h-auto w-3.5"
																		src={documentActionsIcon}
																	/>
																}
															/>
														</div>
													)}
												</li>
											);
										})}
									</ul>
								)}
							</DocumentRow>
						);
					})}
				</ul>
			)}
			{documents.status === "loading" && groups.length > 0 && (
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
			ref={item}
			tabIndex={-1}
		>
			<div className="project-sidebar-project-row" data-flash={flash || undefined}>
				<button
					aria-controls={expanded ? contentId : undefined}
					aria-expanded={expanded}
					className="project-sidebar-project-disclosure flex min-w-0 flex-1 items-center gap-2 text-left"
					onClick={onToggle}
					ref={disclosure}
					type="button"
				>
					<MotionDisclosureIcon
						className="motion-feedback shrink-0"
						closed={<ChevronIcon size={14} />}
						open={expanded}
						opened={<ChevronIcon className="rotate-90" size={14} />}
					/>
					<DocumentIcon />
					<span className="truncate text-sm font-bold">{label}</span>
				</button>
				{!archiveMode && project.available && canManage && (
					<button
						aria-busy={!!phase}
						aria-label={`New document in ${label}`}
						className={`project-sidebar-action ${phase ? "project-sidebar-action-pending" : ""}`}
						data-press="small"
						data-tooltip="New document"
						disabled={!!phase}
						onClick={() => onCreateDocument(project)}
						title={`New document in ${label}`}
						type="button"
					>
						<NavigationIcon src={newDocumentIcon} />
					</button>
				)}
			</div>
			<div className={phase ? "project-sidebar-status" : undefined} role="status">
				{phase === "creating" ? "Creating document…" : phase ? "Opening document…" : ""}
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
		accountMenuId,
		accountTriggerRef,
		accountWrapRef,
		canCreateDocument,
		newDocumentPhase,
		pendingCreations,
		currentDocumentId,
		onAccount,
		focusProjectId,
		onAddProject,
		onFocusedProject,
		onCollapse,
		onCreateDocument,
		onDocumentAction,
		onLoadMore,
		onNewDocument,
		onSearch,
		onCatalogueModeChange,
		projects,
		catalogueMode,
		user,
	}: {
		accountMenu?: false | {
			className: string;
			closing: boolean;
			onDismiss: () => void;
			onShortcuts: () => void;
			onSignOut: () => void;
		};
		accountMenuOpen?: boolean;
		accountMenuId?: string;
		accountTriggerRef?: Ref<HTMLButtonElement>;
		accountWrapRef?: Ref<HTMLDivElement>;
		canCreateDocument: boolean;
		catalogueMode: "active" | "archived";
		newDocumentPhase?: DocumentCreationPhase | "loading";
		pendingCreations: ReadonlyMap<string, DocumentCreationPhase>;
		currentDocumentId?: string;
		onAccount: () => void;
		focusProjectId?: string;
		onAddProject: () => void;
		onFocusedProject?: () => void;
		onCollapse: () => void;
		onCreateDocument: (project: Api.NavigationProject) => void;
		onDocumentAction: (channel: Api.Channel, action: DocumentAction) => void;
		onLoadMore: (entry: ProjectDocuments) => void;
		onNewDocument: () => void;
		onSearch: () => void;
		onCatalogueModeChange: (mode: "active" | "archived") => void;
		projects: ProjectDocuments[];
		user: Api.User;
	},
) {
	let [collapsedProjectIds, setCollapsedProjectIds] = useState<ReadonlySet<string>>(
		() => new Set(),
	);
	useEffect(() => {
		let timer = window.setTimeout(() => {
			void import("./dialog-prefetch").then(module =>
				module.prefetchDialogs(
					user.id,
					projects.map(entry => entry.project),
					catalogueMode === "archived",
					projects,
				)
			);
		}, 1500);
		return () => window.clearTimeout(timer);
	}, [catalogueMode, projects, user.id]);
	let archivedButton = useRef<HTMLButtonElement>(null);
	let allDocumentsButton = useRef<HTMLButtonElement>(null);
	let archiveMode = catalogueMode === "archived";
	let platform = currentShortcutPlatform();
	let primaryActions = (
		<div className="project-sidebar-primary-actions">
			{archiveMode
				? (
					<button
						className="project-sidebar-primary-action"
						onClick={() => {
							onCatalogueModeChange("active");
							requestAnimationFrame(() => archivedButton.current?.focus({ preventScroll: true }));
						}}
						ref={allDocumentsButton}
						type="button"
					>
						<span aria-hidden="true">←</span>
						<span>All documents</span>
					</button>
				)
				: (
					<>
						<button
							aria-busy={!!newDocumentPhase}
							aria-label="New document"
							className="project-sidebar-primary-action"
							disabled={!canCreateDocument || !!newDocumentPhase}
							onClick={onNewDocument}
							type="button"
						>
							<NavigationIcon src={newDocumentIcon} />
							<span>
								{newDocumentPhase === "creating"
									? "Creating document…"
									: newDocumentPhase === "opening"
									? "Opening document…"
									: newDocumentPhase === "loading"
									? "Loading projects…"
									: "New document"}
							</span>
							{!newDocumentPhase && (
								<kbd aria-hidden="true" className="project-sidebar-hint">
									{shortcutLabel("new-document", platform)}
								</kbd>
							)}
						</button>
						<button
							className="project-sidebar-primary-action"
							onClick={onSearch}
							type="button"
						>
							<SearchIcon />
							<span>Search</span>
							<kbd aria-hidden="true" className="project-sidebar-hint">
								{shortcutLabel("search", platform)}
							</kbd>
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
						requestAnimationFrame(() => allDocumentsButton.current?.focus({ preventScroll: true }));
					}}
					ref={archivedButton}
					type="button"
				>
					<ArchiveIcon />
					<span>Archived</span>
				</button>
			</div>
		)
		: null;
	return (
		<aside
			aria-label="Projects"
			className="project-sidebar"
			data-project-sidebar=""
			data-tooltip-edge=""
		>
			<div className="min-h-0 flex-1 overflow-y-auto">
				<header className="project-sidebar-header group/sidebar-header">
					<div className="flex items-center gap-2">
						<img alt="" height={14} src={chopinIcon} width={14} />
						<span className="text-sm font-semibold text-brand">Chopin</span>
					</div>
					<button
						aria-label="Hide sidebar"
						className="project-sidebar-action"
						data-press="small"
						data-tooltip="Hide sidebar"
						data-tooltip-shortcut={shortcutLabel("toggle-sidebar", platform)}
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
								aria-label="Add project"
								data-tooltip="Add project"
								className="project-sidebar-action"
								data-press="small"
								onClick={onAddProject}
								type="button"
							>
								<NavigationIcon className="size-3.5" src={addProjectIcon} />
							</button>
						)}
					</div>
					{newDocumentPhase === "loading" && projects.length === 0 && <ProjectSidebarSkeleton />}
					<ul className="project-sidebar-projects gap-2">
						{[...projects].sort((first, second) => first.project.position - second.project.position)
							.map(entry => (
								<Project
									archiveMode={archiveMode}
									pendingCreations={pendingCreations}
									currentDocumentId={currentDocumentId}
									entry={entry}
									expanded={!collapsedProjectIds.has(entry.project.repositoryId)}
									focus={focusProjectId === entry.project.repositoryId}
									key={entry.project.repositoryId}
									onCreateDocument={onCreateDocument}
									onDocumentAction={onDocumentAction}
									onFocused={onFocusedProject ?? noop}
									onLoadMore={onLoadMore}
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
			<div className="project-sidebar-account-wrap" ref={accountWrapRef}>
				<button
					aria-controls={accountMenu ? accountMenuId : undefined}
					aria-haspopup="menu"
					ref={accountTriggerRef}
					className="project-sidebar-account"
					aria-expanded={accountMenuOpen ?? !!accountMenu}
					onClick={onAccount}
					type="button"
				>
					<Face decorative handle={user.login} size={20} titled={false} />
					<span className="truncate">{user.login}</span>
				</button>
				{accountMenu && (
					<div
						aria-hidden={accountMenu.closing ? "true" : undefined}
						className={`navigation-account-menu motion-dropdown ${accountMenu.className}`}
						id={accountMenuId}
						inert={accountMenu.closing}
						onKeyDown={event => {
							if (event.key === "Tab") return accountMenu.onDismiss();
							if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
							event.preventDefault();
							let items = [...event.currentTarget.querySelectorAll<HTMLElement>("[role=menuitem]")];
							items[
								menuItemTarget(
									event.key,
									items.indexOf(document.activeElement as HTMLElement),
									items.length,
								)
							]
								?.focus();
						}}
						role="menu"
					>
						<a href="/auth/github/install" rel="noopener" role="menuitem" target="_blank">
							<LockIcon aria-hidden="true" size={14} />
							Manage repository access
						</a>
						<button
							className="navigation-account-menu-item"
							onClick={accountMenu.onShortcuts}
							role="menuitem"
							type="button"
						>
							Keyboard shortcuts<kbd aria-hidden="true">?</kbd>
						</button>
						<div role="separator" />
						<button onClick={accountMenu.onSignOut} role="menuitem" type="button">
							<SignInIcon aria-hidden="true" className="-scale-x-100" size={14} />
							Sign out
						</button>
					</div>
				)}
			</div>
		</aside>
	);
}
