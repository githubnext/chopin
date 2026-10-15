import { useEffect, useId, useRef, useState } from "react";
import { Drawer } from "@base-ui/react/drawer";
import { Face } from "@chopin/editor/face";
import { childDocumentPath, documentPath } from "@chopin/protocol/document-url";
import {
	ArchiveIcon,
	CheckIcon,
	ChevronIcon,
	CloseIcon,
	DocumentIcon,
	EllipsisIcon,
	LockIcon,
	PlusIcon,
	SearchIcon,
	SignInIcon,
} from "@chopin/icons";

import { ActionSheet } from "./action-sheet";
import { unansweredDecisionsLabel } from "./decision-view-control";
import { DocumentActionsMenu } from "./document-actions-menu";
import { MachinesEntry } from "./machines-entry";
import {
	browserStorage,
	documentGroups,
	filterDocumentGroups,
	readRecentIds,
	recentDocuments,
} from "./documents-sheet-model";
import { canManageProject, documentDestination } from "./navigation-model";

import "./phone-sheets.css";

import type { MouseEvent, RefObject } from "react";
import type * as Api from "./api";
import type { ProjectDocuments } from "./document-actions";
import type { DocumentAction } from "./document-actions-menu";
import type { DocumentCreationPhase } from "./use-document-creation";

type Page = "documents" | "archived";

/**
 * Phones navigate documents from a bottom sheet rather than the desktop's left drawer: one
 * project at a time, filtered inline, with archived documents a page deeper inside the sheet.
 * It reads the same catalogue as the Projects sidebar.
 */
export function DocumentsSheet(
	{
		activeRepositoryId,
		catalogueMode,
		currentDocumentId,
		machinesCurrent,
		onAddProject,
		onCatalogueModeChange,
		onCreateDocument,
		onDocumentAction,
		onLoadMore,
		onNavigate,
		onOpenChange,
		onSignOut,
		open,
		opener,
		pendingCreations,
		projects,
		user,
	}: {
		activeRepositoryId?: string;
		catalogueMode: "active" | "archived";
		currentDocumentId?: string;
		/** /machines is open, so the Machines row is the current page. */
		machinesCurrent?: boolean;
		onAddProject: () => void;
		onCatalogueModeChange: (mode: "active" | "archived") => void;
		onCreateDocument: (project: Api.NavigationProject) => void;
		onDocumentAction: (channel: Api.Channel, action: DocumentAction) => void;
		onLoadMore: (entry: ProjectDocuments) => void;
		onNavigate: (documentId: string, path: string) => void;
		onOpenChange: (open: boolean) => void;
		onSignOut: () => void;
		open: boolean;
		opener: RefObject<HTMLButtonElement | null>;
		pendingCreations: ReadonlyMap<string, DocumentCreationPhase>;
		projects: ProjectDocuments[];
		user: Api.User;
	},
) {
	// Mounting closed and opening a frame later lets the sheet rise rather than appear.
	let [ready, setReady] = useState(false);
	useEffect(() => {
		let frame = requestAnimationFrame(() => setReady(true));
		return () => cancelAnimationFrame(frame);
	}, []);
	let sorted = [...projects].sort((first, second) =>
		first.project.position - second.project.position
	);
	let [chosenId, setChosenId] = useState<string>();
	let [switching, setSwitching] = useState(false);
	let [query, setQuery] = useState("");
	let [page, setPage] = useState<Page>("documents");
	let [account, setAccount] = useState(false);
	let close = useRef<HTMLButtonElement>(null);
	let dismissed = useRef(false);
	let back = useRef<HTMLButtonElement>(null);
	let archivedRow = useRef<HTMLButtonElement>(null);
	let projectListId = useId();
	let entry = sorted.find(value => value.project.repositoryId === chosenId)
		?? sorted.find(value => value.project.repositoryId === activeRepositoryId)
		?? sorted.find(value => value.project.available)
		?? sorted[0];

	let showPage = (next: Page) => {
		setPage(next);
		onCatalogueModeChange(next === "archived" ? "archived" : "active");
		requestAnimationFrame(() =>
			(next === "archived" ? back : archivedRow).current?.focus({ preventScroll: true })
		);
	};
	let reset = () => {
		setChosenId(undefined);
		setSwitching(false);
		setQuery("");
		setPage("documents");
		if (catalogueMode === "archived") onCatalogueModeChange("active");
	};
	let follow = (documentId: string, path: string) => (event: MouseEvent<HTMLAnchorElement>) => {
		if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
			return;
		}
		event.preventDefault();
		onNavigate(documentId, path);
	};

	let project = entry?.project;
	let label = project ? `${project.repositoryOwner}/${project.repositoryName}` : "Documents";
	let canManage = project ? project.available && canManageProject(project) : false;
	let phase = project ? pendingCreations.get(project.repositoryId) : undefined;

	let tree = (archived: boolean) => {
		if (!entry) return null;
		let { documents } = entry;
		let groups = documentGroups(documents.channels, archived);
		let shown = archived ? groups : filterDocumentGroups(groups, query);
		let unanswered = (channel: Api.Channel) => archived ? 0 : channel.unansweredDecisions ?? 0;
		let row = (channel: Api.Channel, path: string, child: boolean) => {
			let count = unanswered(channel);
			let current = channel.id === currentDocumentId;
			return (
				<li
					className="documents-sheet-row"
					data-child={child || undefined}
					data-current={current || undefined}
					data-document-id={channel.id}
					key={channel.id}
				>
					<a
						aria-current={current ? "page" : undefined}
						aria-label={count > 0 ? unansweredDecisionsLabel(channel.title, count) : undefined}
						className="documents-sheet-link"
						href={path}
						onClick={follow(channel.id, path)}
					>
						<span className="truncate">{channel.title}</span>
						{count > 0 && <span aria-hidden="true" className="documents-sheet-count">{count}</span>}
					</a>
					{canManageProject(entry.project) && (
						<DocumentActionsMenu
							channel={channel}
							className="documents-sheet-more"
							onAction={action => onDocumentAction(channel, action)}
							trigger={<EllipsisIcon aria-hidden="true" size={18} />}
						/>
					)}
				</li>
			);
		};
		return (
			<>
				{documents.status === "unavailable" && (
					<p className="documents-sheet-status" role="status">Access unavailable</p>
				)}
				{documents.status === "error" && (
					<p className="documents-sheet-status" role="status">{documents.message}</p>
				)}
				{documents.status === "loading" && groups.length === 0 && (
					<p className="documents-sheet-status" role="status">Loading documents…</p>
				)}
				{documents.status === "ready" && shown.length === 0 && !documents.nextCursor && (
					<p className="documents-sheet-status">
						{query && !archived
							? `No documents match “${query.trim()}”`
							: archived
							? "No archived documents"
							: "No documents"}
					</p>
				)}
				{shown.length > 0 && (
					<ul className="documents-sheet-list">
						{shown.flatMap(({ children, parent }) => {
							let parentPath = documentPath(
								parent.repositoryOwner,
								parent.repositoryName,
								parent.slug,
							);
							return [
								row(parent, parentPath, false),
								...children.map(child =>
									row(
										child,
										childDocumentPath(
											parent.repositoryOwner,
											parent.repositoryName,
											parent.slug,
											child.slug,
										),
										true,
									)
								),
							];
						})}
					</ul>
				)}
				{documents.status === "ready" && documents.nextCursor && (
					<button
						className="documents-sheet-load-more"
						onClick={() => onLoadMore(entry)}
						type="button"
					>
						Load more
					</button>
				)}
			</>
		);
	};

	let recents = entry && open && page === "documents" && !query.trim()
		? recentDocuments(
			readRecentIds(browserStorage(), user.id, entry.project.repositoryId),
			entry.documents.channels,
			currentDocumentId,
		)
		: [];

	return (
		<Drawer.Root
			onOpenChange={next => {
				dismissed.current = !next;
				onOpenChange(next);
			}}
			onOpenChangeComplete={next => {
				if (next) return;
				reset();
				// A dismissal hands focus back once the sheet, and any field in it, has gone.
				if (dismissed.current) opener.current?.focus({ preventScroll: true });
				dismissed.current = false;
			}}
			open={ready && open}
		>
			<Drawer.Portal>
				<Drawer.Backdrop className="phone-sheet-backdrop" />
				<Drawer.Viewport className="phone-sheet-viewport">
					<Drawer.Popup
						className="documents-sheet"
						data-documents-sheet=""
						data-page={page}
						finalFocus={false}
						initialFocus={close}
					>
						<span aria-hidden="true" className="phone-sheet-grabber" />
						<Drawer.Title className="sr-only">Documents</Drawer.Title>
						<div className="documents-sheet-pages">
							<section
								aria-hidden={page === "documents" ? undefined : "true"}
								className="documents-sheet-page"
								data-sheet-page="documents"
								inert={page !== "documents"}
							>
								<header className="documents-sheet-head">
									<button
										aria-controls={switching ? projectListId : undefined}
										aria-expanded={switching}
										aria-label={`Project: ${label}`}
										className="documents-sheet-project"
										onClick={() => setSwitching(value => !value)}
										type="button"
									>
										<DocumentIcon aria-hidden="true" />
										<span className="truncate">{label}</span>
										<ChevronIcon
											aria-hidden="true"
											className="documents-sheet-project-chevron"
											data-open={switching || undefined}
											size={16}
										/>
									</button>
									<Drawer.Close
										aria-label="Close documents"
										className="phone-sheet-close"
										ref={close}
									>
										<CloseIcon aria-hidden="true" size={16} />
									</Drawer.Close>
								</header>
								{switching && (
									<ul aria-label="Projects" className="documents-sheet-projects" id={projectListId}>
										{sorted.map(value => {
											let selected = value === entry;
											let name = `${value.project.repositoryOwner}/${value.project.repositoryName}`;
											return (
												<li key={value.project.repositoryId}>
													<button
														aria-pressed={selected}
														className="documents-sheet-option"
														onClick={() => {
															setChosenId(value.project.repositoryId);
															setSwitching(false);
														}}
														type="button"
													>
														<span className="truncate">{name}</span>
														{selected && <CheckIcon aria-hidden="true" size={18} />}
													</button>
												</li>
											);
										})}
										<li>
											<button
												className="documents-sheet-option"
												onClick={onAddProject}
												type="button"
											>
												<PlusIcon aria-hidden="true" size={18} />
												<span>Add project</span>
											</button>
										</li>
									</ul>
								)}
								<label className="documents-sheet-search">
									<SearchIcon aria-hidden="true" size={16} />
									<span className="sr-only">Search documents</span>
									<input
										autoComplete="off"
										enterKeyHint="search"
										onChange={event => setQuery(event.target.value)}
										placeholder="Search documents"
										type="search"
										value={query}
									/>
								</label>
								<div className="documents-sheet-scroll">
									{recents.length > 0 && (
										<section aria-label="Recent" className="documents-sheet-section" data-recent="">
											<h3 className="documents-sheet-heading">Recent</h3>
											<ul className="documents-sheet-recents">
												{recents.map(channel => {
													let path = documentDestination(projects, channel.id);
													return (
														<li key={channel.id}>
															<a
																className="documents-sheet-recent"
																href={path}
																onClick={follow(channel.id, path)}
															>
																<span className="documents-sheet-recent-title">
																	{channel.title}
																</span>
															</a>
														</li>
													);
												})}
											</ul>
										</section>
									)}
									<section aria-label="Documents" className="documents-sheet-section">
										{recents.length > 0 && <h3 className="documents-sheet-heading">Documents</h3>}
										{tree(false)}
									</section>
									<ul className="documents-sheet-list documents-sheet-footer-list">
										<li className="documents-sheet-row">
											<button
												className="documents-sheet-link"
												onClick={() => showPage("archived")}
												ref={archivedRow}
												type="button"
											>
												<ArchiveIcon aria-hidden="true" className="documents-sheet-row-icon" />
												<span className="truncate">Archived</span>
												<ChevronIcon aria-hidden="true" className="ml-auto" size={16} />
											</button>
										</li>
										<li className="documents-sheet-row" data-current={machinesCurrent || undefined}>
											<MachinesEntry current={machinesCurrent} placement="sheet" />
										</li>
										<li className="documents-sheet-row">
											<button
												aria-haspopup="dialog"
												className="documents-sheet-link"
												onClick={() => setAccount(true)}
												type="button"
											>
												<Face decorative handle={user.login} size={24} titled={false} />
												<span className="truncate">{user.login}</span>
											</button>
										</li>
									</ul>
								</div>
								{project && canManage && (
									<div className="documents-sheet-actions">
										<button
											aria-busy={!!phase}
											className="btn btn-md btn-primary documents-sheet-new"
											disabled={!!phase}
											onClick={() => onCreateDocument(project)}
											type="button"
										>
											<PlusIcon aria-hidden="true" size={18} />
											{phase === "creating"
												? "Creating document…"
												: phase
												? "Opening document…"
												: "New document"}
										</button>
									</div>
								)}
							</section>
							<section
								aria-hidden={page === "archived" ? undefined : "true"}
								aria-label="Archived"
								className="documents-sheet-page"
								data-sheet-page="archived"
								inert={page !== "archived"}
							>
								<header className="documents-sheet-head">
									<button
										aria-label="Back to documents"
										className="documents-sheet-back"
										onClick={() => showPage("documents")}
										ref={back}
										type="button"
									>
										<ChevronIcon aria-hidden="true" className="rotate-180" size={16} />
										<span>Documents</span>
									</button>
									<h3 className="documents-sheet-page-title">Archived</h3>
									<Drawer.Close aria-label="Close documents" className="phone-sheet-close">
										<CloseIcon aria-hidden="true" size={16} />
									</Drawer.Close>
								</header>
								<div className="documents-sheet-scroll">
									{page === "archived" && tree(true)}
								</div>
							</section>
						</div>
						{account && (
							<ActionSheet
								immediate={["access", "sign-out"]}
								items={[
									{ action: "access", icon: LockIcon, label: "Manage repository access" },
									{ action: "sign-out", icon: SignInIcon, label: "Sign out" },
								]}
								label={`Account: ${user.login}`}
								onClose={() => setAccount(false)}
								onSelect={action => {
									if (action === "access") {
										window.open("/auth/github/install", "_blank", "noopener");
									} else onSignOut();
								}}
								title={user.login}
							/>
						)}
					</Drawer.Popup>
				</Drawer.Viewport>
			</Drawer.Portal>
		</Drawer.Root>
	);
}
