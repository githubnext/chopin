import chopinIcon from "./assets/figma/navigation/chopin.svg";
import collapseIcon from "./assets/icons/panel-close.svg";
import documentActionsIcon from "./assets/figma/navigation/document-actions.svg";
import { unansweredDecisionsLabel, useDecisionAttention } from "./decision-view-control";
import { DocumentActionsMenu } from "./document-actions-menu";
import { IconButton } from "./icon-button";
import { MenuItem, MenuSeparator } from "./menu-item";
import { ProjectSidebarSkeleton } from "./project-sidebar-chrome";
import { motionContract } from "./motion-contract";
import { motionImmediately } from "./motion-input";
import { canManageProject } from "./navigation-model";
import { currentShortcutPlatform, shortcutLabel } from "./shortcuts";
import { Count, Face, MotionDisclosure, MotionDisclosureIcon } from "@chopin/editor";
import { childDocumentPath, documentPath } from "@chopin/protocol/document-url";
import { useSidebarRowPresence } from "./sidebar-row-presence";

import { useEffect, useId, useRef, useState } from "react";
import {
	ArchiveIcon,
	ChevronIcon,
	DocumentIcon,
	KeyboardIcon,
	LockIcon,
	PlusIcon,
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

function UnansweredCount({ unanswered }: { unanswered: number }) {
	let attention = useDecisionAttention(unanswered);
	if (unanswered <= 0) return null;
	return (
		<span aria-hidden="true" className="project-sidebar-count" data-sidebar-decision-count="">
			<Count
				appearance="quiet"
				typography="metadata"
				key={attention ? `attention-${unanswered}` : "settled"}
				motion={attention}
			>
				{unanswered}
			</Count>
		</span>
	);
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
		revealed,
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
		revealed: boolean;
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
	let documentUnanswered = (channel: Api.Channel) =>
		archiveMode ? 0 : channel.unansweredDecisions ?? 0;
	let projectUnanswered = archiveMode || documents.status === "unavailable"
		? 0
		: documents.unansweredDecisions ?? 0;
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
										aria-label={documentUnanswered(channel) > 0
											? unansweredDecisionsLabel(channel.title, documentUnanswered(channel))
											: undefined}
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
												iconButton
												onAction={action => documentAction(channel, action)}
												trigger={
													<NavigationIcon className="h-auto w-3" src={documentActionsIcon} />
												}
											/>
										</div>
									)}
									<UnansweredCount unanswered={documentUnanswered(channel)} />
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
														aria-label={documentUnanswered(child) > 0
															? unansweredDecisionsLabel(child.title, documentUnanswered(child))
															: undefined}
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
																iconButton
																onAction={action => onDocumentAction(child, action)}
																trigger={
																	<NavigationIcon
																		className="h-auto w-3"
																		src={documentActionsIcon}
																	/>
																}
															/>
														</div>
													)}
													<UnansweredCount unanswered={documentUnanswered(child)} />
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
			data-revealed={revealed || undefined}
			tabIndex={-1}
		>
			<div className="project-sidebar-project-row" data-flash={flash || undefined}>
				<button
					aria-controls={expanded ? contentId : undefined}
					aria-expanded={expanded}
					aria-label={projectUnanswered > 0
						? unansweredDecisionsLabel(label, projectUnanswered)
						: undefined}
					className="project-sidebar-project-disclosure flex min-w-0 flex-1 items-center gap-2 text-left"
					onClick={onToggle}
					ref={disclosure}
					type="button"
				>
					<span aria-hidden="true" className="project-sidebar-project-icon">
						<DocumentIcon className="project-sidebar-project-repository-icon" />
						<span className="project-sidebar-project-chevron">
							<MotionDisclosureIcon
								className="motion-feedback shrink-0"
								closed={<ChevronIcon size={12} />}
								open={expanded}
								opened={<ChevronIcon className="rotate-90" size={12} />}
							/>
						</span>
					</span>
					<span className="truncate text-xs font-bold">{label}</span>
				</button>
				{!archiveMode && project.available && canManage && (
					<IconButton
						aria-busy={!!phase}
						aria-label={`New document in ${label}`}
						glyph="compact"
						pending={!!phase}
						placement="sidebar"
						size="compact"
						tone="nested"
						data-tooltip="New document"
						disabled={!!phase}
						onClick={() => onCreateDocument(project)}
						title={`New document in ${label}`}
					>
						<PlusIcon size={12} />
					</IconButton>
				)}
				<UnansweredCount unanswered={projectUnanswered} />
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
		onRevealed,
		onSearch,
		onCatalogueModeChange,
		projects,
		catalogueMode,
		reveal,
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
		onRevealed?: () => void;
		onSearch: () => void;
		onCatalogueModeChange: (mode: "active" | "archived") => void;
		projects: ProjectDocuments[];
		reveal?: { id: string; nonce: number };
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
	let [revealedId, setRevealedId] = useState<string>();
	useEffect(() => {
		if (!reveal) return;
		setCollapsedProjectIds(current => {
			if (!current.has(reveal.id)) return current;
			let next = new Set(current);
			next.delete(reveal.id);
			return next;
		});
		setRevealedId(reveal.id);
		let frame = requestAnimationFrame(() => {
			let row = document.querySelector<HTMLElement>(
				`[data-project-id="${CSS.escape(reveal.id)}"] .project-sidebar-project-disclosure`,
			);
			row?.scrollIntoView({ block: "nearest" });
			row?.focus({ preventScroll: true });
		});
		let timer = setTimeout(() => {
			setRevealedId(undefined);
			onRevealed?.();
		}, 1400);
		return () => {
			cancelAnimationFrame(frame);
			clearTimeout(timer);
		};
	}, [reveal]);
	let archivedButton = useRef<HTMLButtonElement>(null);
	let allDocumentsButton = useRef<HTMLButtonElement>(null);
	let archiveMode = catalogueMode === "archived";
	let platform = currentShortcutPlatform();
	let actionsRef = useRef<HTMLDivElement>(null);
	let listRef = useRef<HTMLElement>(null);
	let shownMode = useRef(catalogueMode);
	useEffect(() => {
		if (shownMode.current === catalogueMode) return;
		shownMode.current = catalogueMode;
		if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
		let style = getComputedStyle(actionsRef.current ?? document.documentElement);
		let offset = catalogueMode === "archived" ? "8px" : "-8px";
		for (let element of [actionsRef.current, listRef.current]) {
			element?.animate(
				[{ opacity: 0, transform: `translateX(${offset})` }, { opacity: 1, transform: "none" }],
				{
					duration: parseFloat(style.getPropertyValue("--duration-base")) || 200,
					easing: style.getPropertyValue("--motion-smooth-out").trim() || "ease-out",
				},
			);
		}
	}, [catalogueMode]);
	let searchButton = (
		<button className="project-sidebar-primary-action" onClick={onSearch} type="button">
			<SearchIcon size={12} />
			<span>Search</span>
			<kbd aria-hidden="true" className="project-sidebar-hint">
				{shortcutLabel("search", platform)}
			</kbd>
		</button>
	);
	let primaryActions = (
		<div
			className="project-sidebar-primary-actions"
			ref={actionsRef}
		>
			{archiveMode
				? (
					<>
						<button
							className="project-sidebar-primary-action"
							onClick={() => {
								onCatalogueModeChange("active");
								requestAnimationFrame(() => archivedButton.current?.focus({ preventScroll: true }));
							}}
							ref={allDocumentsButton}
							type="button"
						>
							<ChevronIcon aria-hidden="true" className="rotate-180" size={14} />
							<span>All documents</span>
						</button>
						{searchButton}
					</>
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
							<PlusIcon />
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
							<SearchIcon size={12} />
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
						<span className="text-xs font-semibold text-brand">Chopin</span>
					</div>
					<IconButton
						aria-label="Hide sidebar"
						placement="sidebar"
						size="compact"
						data-tooltip="Hide sidebar"
						data-tooltip-shortcut={shortcutLabel("toggle-sidebar", platform)}
						onClick={onCollapse}
					>
						<NavigationIcon src={collapseIcon} />
					</IconButton>
				</header>

				{primaryActions}

				<nav
					className="px-2 py-2"
					aria-label={archiveMode ? "Archived documents" : "Projects"}
					ref={listRef}
				>
					<div className="project-sidebar-projects-heading group/projects-heading">
						<span>{archiveMode ? "Archived" : "Projects"}</span>
						{!archiveMode && (
							<IconButton
								aria-label="Add project"
								data-tooltip="Add project"
								glyph="compact"
								placement="sidebar"
								size="compact"
								onClick={onAddProject}
							>
								<PlusIcon size={12} />
							</IconButton>
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
									revealed={revealedId === entry.project.repositoryId}
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
						<MenuItem density="compact" href="/auth/github/install" rel="noopener" target="_blank">
							<LockIcon aria-hidden="true" size={14} />
							Manage repository access
						</MenuItem>
						<MenuItem
							density="compact"
							onClick={accountMenu.onShortcuts}
						>
							<KeyboardIcon aria-hidden="true" size={14} />Keyboard shortcuts
						</MenuItem>
						<MenuSeparator />
						<MenuItem density="compact" onClick={accountMenu.onSignOut}>
							<SignInIcon aria-hidden="true" className="-scale-x-100" size={14} />
							Sign out
						</MenuItem>
					</div>
				)}
			</div>
		</aside>
	);
}
