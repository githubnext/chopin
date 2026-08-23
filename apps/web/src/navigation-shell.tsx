import {
	Component,
	createContext,
	lazy,
	Suspense,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { documentPath, researchWorkspacePath } from "@chopin/protocol/document-url";

import * as Api from "./api";
import { newestDocument } from "./document-actions";
import { NavigationFocusScope } from "./navigation-focus";
import {
	activeProject,
	beginProjectCreation,
	canEditProject,
	documentDestination,
	finishProjectCreation,
	landingDocument,
	NAVIGATION_MEDIA,
	navigationMode,
} from "./navigation-model";
import {
	ProjectSidebar,
	ProjectSidebarExpandButton,
	SIDEBAR_MAX,
	SIDEBAR_MIN,
	SIDEBAR_STORAGE_KEY,
} from "./project-sidebar";
import { clearRepositoryCache } from "./repository-cache";
import { useProjectDocuments } from "./use-project-documents";
import { useProjectResearch } from "./use-project-research";

import type { Research } from "@chopin/protocol";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import type { NavigationMode } from "./navigation-model";

export type Navigate = (destination: string, options?: { replace?: boolean }) => void;

class LazyDialogBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
	override state = { failed: false };

	static getDerivedStateFromError() {
		return { failed: true };
	}

	override render() {
		if (!this.state.failed) return this.props.children;
		return (
			<div className="navigation-error" role="alert">
				Could not load this dialog.
				<button
					className="btn btn-sm btn-secondary ml-2"
					onClick={() => location.reload()}
					type="button"
				>
					Reload
				</button>
			</div>
		);
	}
}

let NewResearchDialog = lazy(() =>
	import("./research-actions").then(module => ({ default: module.NewResearchDialog }))
);
let AddProjectDialog = lazy(() =>
	import("./add-project-dialog").then(module => ({ default: module.AddProjectDialog }))
);
let DocumentSearchDialog = lazy(() =>
	import("./document-search-dialog").then(module => ({ default: module.DocumentSearchDialog }))
);
let RenameDocumentDialog = lazy(() =>
	import("./rename-document-dialog").then(module => ({ default: module.RenameDocumentDialog }))
);

type Route =
	| { page: "repositories" }
	| { page: "repository"; owner: string; repository: string }
	| { page: "document"; owner: string; repository: string; slug: string }
	| {
		page: "research";
		owner: string;
		repository: string;
		slug: string;
		workspaceId: string;
	}
	| { page: "channel"; id: string };

type NavigationFailure = { reason: unknown; retry: "refresh" | "visit" };

let NavigationDocument = createContext<{
	channel?: Api.Channel;
	onDocumentChanged: (
		documentId: string,
		update: Pick<Api.Channel, "title" | "slug" | "updatedAt">,
	) => void;
	onDocumentLoaded: (channel: Api.Channel) => Promise<void>;
	onRepositoryAccessChanged: () => void;
	onResearchWorkspaceChanged: (
		channel: Api.ResearchParentChannel,
		workspaceId: string,
		revision: number,
	) => void;
	onResearchWorkspaceLoaded: (
		channel: Api.ResearchParentChannel,
		workspace: Research.WorkspaceSummary,
	) => void;
	onResearchWorkspacesRefresh: (channel: Api.ResearchParentChannel) => void;
	onRenameDocument: () => void;
}>({
	onDocumentChanged() {},
	async onDocumentLoaded() {},
	onRepositoryAccessChanged() {},
	onResearchWorkspaceChanged() {},
	onResearchWorkspaceLoaded() {},
	onResearchWorkspacesRefresh() {},
	onRenameDocument() {},
});

export function useNavigationDocument() {
	return useContext(NavigationDocument);
}

function clamp(width: number): number {
	return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, width));
}

function currentMode(): NavigationMode {
	return navigationMode(matchMedia);
}

function subscribeMode(notify: () => void): () => void {
	let query = matchMedia(NAVIGATION_MEDIA);
	query.addEventListener("change", notify);
	return () => query.removeEventListener("change", notify);
}

function useNavigationMode(): NavigationMode {
	return useSyncExternalStore(subscribeMode, currentMode, () => "inline");
}

function useSidebarWidth() {
	let [width, setWidth] = useState(() => {
		let stored = Number(localStorage.getItem(SIDEBAR_STORAGE_KEY));
		return Number.isFinite(stored) ? clamp(stored) : SIDEBAR_MIN;
	});

	useEffect(() => localStorage.setItem(SIDEBAR_STORAGE_KEY, String(width)), [width]);
	return [width, (delta: number) => setWidth(current => clamp(current + delta))] as const;
}

function SidebarResizeHandle(
	{ onResize, width }: { onResize: (delta: number) => void; width: number },
) {
	let origin = useRef(0);
	return (
		<div
			aria-label="Resize Projects sidebar"
			aria-orientation="vertical"
			aria-valuemax={SIDEBAR_MAX}
			aria-valuemin={SIDEBAR_MIN}
			aria-valuenow={width}
			className="project-sidebar-resize"
			onKeyDown={event => {
				let step = event.shiftKey ? 64 : 16;
				if (event.key === "ArrowRight") onResize(step);
				else if (event.key === "ArrowLeft") onResize(-step);
				else if (event.key === "Home") onResize(SIDEBAR_MIN - width);
				else if (event.key === "End") onResize(SIDEBAR_MAX - width);
				else return;
				event.preventDefault();
			}}
			onPointerDown={event => {
				origin.current = event.clientX;
				event.currentTarget.setPointerCapture(event.pointerId);
			}}
			onPointerMove={event => {
				if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
				let delta = event.clientX - origin.current;
				origin.current = event.clientX;
				onResize(delta);
			}}
			role="separator"
			tabIndex={0}
		/>
	);
}

function NavigationDrawer(
	{ children, onDismiss }: { children: ReactNode; onDismiss: () => void },
) {
	return (
		<div className="navigation-drawer" role="presentation">
			<button
				aria-label="Close Projects sidebar"
				className="navigation-drawer-backdrop"
				onClick={onDismiss}
				type="button"
			/>
			<NavigationFocusScope onDismiss={onDismiss}>
				<div
					aria-label="Projects"
					aria-modal="true"
					className="project-sidebar-frame"
					role="dialog"
					tabIndex={-1}
				>
					{children}
				</div>
			</NavigationFocusScope>
		</div>
	);
}

export function NavigationShell(
	{
		children,
		navigate,
		route,
		user,
	}: {
		children?: ReactNode;
		navigate: Navigate;
		route: Route;
		user: Api.User;
	},
) {
	let [navigation, setNavigation] = useState<Api.Navigation>();
	let navigationRef = useRef<Api.Navigation | undefined>(undefined);
	let navigationRequest = useRef<Promise<void> | undefined>(undefined);
	let navigationRefreshQueued = useRef(false);
	let pendingVisitedRepository = useRef<string | undefined>(undefined);
	let visitTail = useRef<Promise<void>>(Promise.resolve());
	let visitRevision = useRef(0);
	let latestVisitedDocument = useRef<string | undefined>(undefined);
	let catalogueRefreshes = useRef(new Map<string, number>([["navigation", Date.now()]]));
	let [error, setError] = useState<NavigationFailure>();
	let [resolvedDocument, setResolvedDocument] = useState<{
		channel: Api.Channel;
		routeKey: string;
	}>();
	let [collapsed, setCollapsed] = useState(() =>
		localStorage.getItem(`${SIDEBAR_STORAGE_KEY}:collapsed`) === "true"
	);
	let [drawerOpen, setDrawerOpen] = useState(false);
	let drawerOpener = useRef<HTMLButtonElement>(null);
	let [dialog, setDialog] = useState<
		| "add"
		| "search"
		| { channel: Api.Channel; type: "rename" | "research" }
	>();
	let [accountOpen, setAccountOpen] = useState(false);
	let creatingProjectIds = useRef<Set<string>>(new Set());
	let [creatingProjectIdsForView, setCreatingProjectIdsForView] = useState<ReadonlySet<string>>(
		() => new Set(),
	);
	let [focusProjectId, setFocusProjectId] = useState<string>();
	let [width, resize] = useSidebarWidth();
	let mode = useNavigationMode();
	let sidebarVisible = mode === "inline" && !collapsed;
	let triggerVisible = !sidebarVisible && !drawerOpen;
	let { loadMore, projects, refreshProject, updateDocument, upsertDocument } = useProjectDocuments(
		navigation,
	);
	let {
		groups: research,
		refreshResearchChannel,
		refreshResearchWorkspace,
		upsertResearchWorkspace,
	} = useProjectResearch(navigation, projects);
	let routeKey = route.page === "channel"
		? `${route.page}:${route.id}`
		: route.page === "research"
		? `${route.page}:${route.owner}/${route.repository}/${route.slug}/${route.workspaceId}`
		: route.page === "document"
		? `${route.page}:${route.owner}/${route.repository}/${route.slug}`
		: route.page;
	let currentRouteKey = useRef(routeKey);
	currentRouteKey.current = routeKey;
	let resolvedChannel = resolvedDocument?.routeKey === routeKey
		? resolvedDocument.channel
		: undefined;
	let routedChannel = route.page === "document" || route.page === "research"
		? projects.flatMap(project => project.documents.channels).find(channel =>
			channel.repositoryOwner.toLocaleLowerCase() === route.owner.toLocaleLowerCase()
			&& channel.repositoryName.toLocaleLowerCase() === route.repository.toLocaleLowerCase()
			&& channel.slug === route.slug
		)
		: undefined;
	let currentDocumentId = route.page === "channel"
		? route.id
		: routedChannel?.id ?? resolvedChannel?.id;
	let currentResearchWorkspaceId = route.page === "research" ? route.workspaceId : undefined;

	let refresh = useCallback((queue = true): Promise<void> => {
		let active = navigationRequest.current;
		if (active) {
			if (queue) navigationRefreshQueued.current = true;
			return active;
		}
		let request = (async () => {
			do {
				navigationRefreshQueued.current = false;
				setError(current => current?.retry === "visit" ? current : undefined);
				try {
					let visitsBeforeRequest = visitRevision.current;
					let next = await Api.navigation();
					let firstNavigation = navigationRef.current === undefined;
					if (visitRevision.current !== visitsBeforeRequest && latestVisitedDocument.current) {
						next = { ...next, lastDocumentId: latestVisitedDocument.current };
					}
					let refreshedAt = Date.now();
					catalogueRefreshes.current.set("navigation", refreshedAt);
					if (firstNavigation) {
						for (let project of next.projects) {
							catalogueRefreshes.current.set(project.repositoryId, refreshedAt);
						}
					}
					navigationRef.current = next;
					setNavigation(next);
					let visited = pendingVisitedRepository.current;
					if (visited) {
						pendingVisitedRepository.current = undefined;
						if (!next.projects.some(project => project.repositoryId === visited)) {
							navigationRefreshQueued.current = true;
						}
					}
				} catch (reason) {
					setError({ reason, retry: "refresh" });
				}
			} while (navigationRefreshQueued.current);
		})();
		navigationRequest.current = request;
		void request.finally(() => {
			if (navigationRequest.current === request) navigationRequest.current = undefined;
		});
		return request;
	}, []);
	let documentLoaded = useCallback(async (channel: Api.Channel) => {
		setResolvedDocument(current => ({
			channel: current?.routeKey === routeKey && current.channel.id === channel.id
				? newestDocument(current.channel, channel)
				: channel,
			routeKey,
		}));
		upsertDocument(channel);
		let visited = visitTail.current.then(() => Api.visitDocument(channel.id));
		visitTail.current = visited.catch(() => {});
		try {
			await visited;
		} catch (reason) {
			if (currentRouteKey.current === routeKey) setError({ reason, retry: "visit" });
			return;
		}
		setError(current => current?.retry === "visit" ? undefined : current);
		visitRevision.current++;
		latestVisitedDocument.current = channel.id;
		let current = navigationRef.current;
		if (!current) {
			pendingVisitedRepository.current = channel.repositoryId;
			return;
		}
		let next = { ...current, lastDocumentId: channel.id };
		navigationRef.current = next;
		setNavigation(next);
		if (!current.projects.some(project => project.repositoryId === channel.repositoryId)) {
			pendingVisitedRepository.current = channel.repositoryId;
			await refresh();
		}
	}, [refresh, routeKey, upsertDocument]);
	let documentChanged = useCallback((
		documentId: string,
		update: Pick<Api.Channel, "title" | "slug" | "updatedAt">,
	) => {
		updateDocument(documentId, update);
		setResolvedDocument(current =>
			current?.channel.id === documentId && current.channel.updatedAt <= update.updatedAt
				? { ...current, channel: { ...current.channel, ...update } }
				: current
		);
	}, [updateDocument]);

	useEffect(() => {
		void refresh(false);
	}, [refresh]);

	useEffect(() => {
		if (route.page !== "repositories" || !navigation) return;
		let destination = landingDocument(projects, navigation.lastDocumentId);
		if (destination) navigate(documentDestination(projects, destination), { replace: true });
	}, [navigate, navigation, projects, route.page]);

	useEffect(() => {
		localStorage.setItem(`${SIDEBAR_STORAGE_KEY}:collapsed`, String(collapsed));
	}, [collapsed]);

	useEffect(() => {
		if (mode === "inline") setDrawerOpen(false);
	}, [mode]);

	useEffect(() => {
		if (
			route.page !== "channel" && route.page !== "document" && route.page !== "research"
			&& navigation?.projects.length === 0
		) {
			showDialog("add");
		}
	}, [navigation?.projects.length, route.page]);

	useEffect(() => {
		if (!focusProjectId) return;
		let frame = requestAnimationFrame(() => {
			let project = document.querySelector<HTMLElement>(
				`[data-project-id="${CSS.escape(focusProjectId)}"]`,
			);
			if (!project) return;
			project.focus({ preventScroll: true });
			setFocusProjectId(undefined);
		});
		return () => cancelAnimationFrame(frame);
	}, [focusProjectId, projects]);

	let startProjectCreation = (projectId: string): boolean => {
		if (creatingProjectIds.current.has(projectId)) return false;
		let next = beginProjectCreation(creatingProjectIds.current, projectId);
		creatingProjectIds.current = next;
		setCreatingProjectIdsForView(next);
		return true;
	};

	let completeProjectCreation = (projectId: string) => {
		let next = finishProjectCreation(creatingProjectIds.current, projectId);
		creatingProjectIds.current = next;
		setCreatingProjectIdsForView(next);
	};

	let navigateToDocument = (documentId: string, path?: string) => {
		setError(undefined);
		setDialog(undefined);
		setDrawerOpen(false);
		navigate(documentDestination(projects, documentId, path));
	};

	let createDocument = async (project: Api.NavigationProject) => {
		if (!canEditProject(project) || !startProjectCreation(project.repositoryId)) return;
		try {
			let created = await Api.createChannel(project.repositoryOwner, project.repositoryName);
			upsertDocument(created.channel);
			navigateToDocument(
				created.channel.id,
				documentPath(
					created.repository.owner,
					created.repository.name,
					created.channel.slug,
				),
			);
		} catch (reason) {
			setError({ reason, retry: "refresh" });
		} finally {
			completeProjectCreation(project.repositoryId);
		}
	};

	let active = activeProject(projects, currentDocumentId, resolvedChannel?.repositoryId);
	let currentChannel = projects.flatMap(project => project.documents.channels)
		.find(channel => channel.id === currentDocumentId) ?? resolvedChannel;
	let currentChannelRef = useRef<Api.Channel | undefined>(undefined);
	currentChannelRef.current = currentChannel;
	let revalidateCatalogues = useCallback(() => {
		let now = Date.now();
		let navigationRefreshedAt = catalogueRefreshes.current.get("navigation") ?? 0;
		if (now - navigationRefreshedAt >= 30_000) {
			catalogueRefreshes.current.set("navigation", now);
			void refresh();
		}
		if (!active?.available) return;
		let projectRefreshedAt = catalogueRefreshes.current.get(active.repositoryId)
			?? navigationRefreshedAt;
		if (now - projectRefreshedAt < 30_000) {
			catalogueRefreshes.current.set(active.repositoryId, projectRefreshedAt);
			return;
		}
		catalogueRefreshes.current.set(active.repositoryId, now);
		refreshProject(active);
		if (currentChannel) refreshResearchChannel(currentChannel);
	}, [active, currentChannel, refresh, refreshProject, refreshResearchChannel]);
	useEffect(() => {
		revalidateCatalogues();
	}, [revalidateCatalogues, routeKey]);
	useEffect(() => {
		let visible = () => {
			if (document.visibilityState === "visible") revalidateCatalogues();
		};
		window.addEventListener("focus", revalidateCatalogues);
		document.addEventListener("visibilitychange", visible);
		return () => {
			window.removeEventListener("focus", revalidateCatalogues);
			document.removeEventListener("visibilitychange", visible);
		};
	}, [revalidateCatalogues]);
	let newDocument = () => {
		if (active && canEditProject(active)) void createDocument(active);
		else showDialog("add");
	};

	let renamed = (channel: Api.Channel) => {
		upsertDocument(channel);
		setResolvedDocument(current =>
			current?.channel.id === channel.id
				? { ...current, channel: newestDocument(current.channel, channel) }
				: current
		);
	};

	let showDialog = useCallback((next: NonNullable<typeof dialog>) => {
		setDrawerOpen(false);
		setAccountOpen(false);
		setDialog(next);
	}, []);
	let renameCurrentDocument = useCallback(() => {
		let channel = currentChannelRef.current;
		if (channel) showDialog({ type: "rename", channel });
	}, [showDialog]);
	let researchWorkspaceChanged = useCallback((
		channel: Api.ResearchParentChannel,
		workspaceId: string,
		revision: number,
	) => {
		refreshResearchWorkspace(channel, workspaceId, revision);
	}, [refreshResearchWorkspace]);
	let researchWorkspaceLoaded = useCallback((
		channel: Api.ResearchParentChannel,
		workspace: Research.WorkspaceSummary,
	) => {
		upsertResearchWorkspace(channel, workspace);
	}, [upsertResearchWorkspace]);
	let repositoryAccessChanged = useCallback(() => {
		void refresh();
	}, [refresh]);
	let navigationDocument = useMemo(() => ({
		channel: currentChannel,
		onDocumentChanged: documentChanged,
		onDocumentLoaded: documentLoaded,
		onRepositoryAccessChanged: repositoryAccessChanged,
		onResearchWorkspaceChanged: researchWorkspaceChanged,
		onResearchWorkspaceLoaded: researchWorkspaceLoaded,
		onResearchWorkspacesRefresh: refreshResearchChannel,
		onRenameDocument: renameCurrentDocument,
	}), [
		currentChannel,
		documentChanged,
		documentLoaded,
		renameCurrentDocument,
		repositoryAccessChanged,
		researchWorkspaceChanged,
		researchWorkspaceLoaded,
		refreshResearchChannel,
	]);

	let signOut = async () => {
		try {
			await Api.logout();
			clearRepositoryCache(user.id);
			location.assign("/");
		} catch (reason) {
			setError({ reason, retry: "refresh" });
		}
	};

	let retryError = () => {
		if (!error) return;
		if (error.retry === "visit" && currentChannelRef.current) {
			void documentLoaded(currentChannelRef.current);
		} else void refresh();
	};
	let dismissDrawer = () => {
		setDrawerOpen(false);
		requestAnimationFrame(() => drawerOpener.current?.focus({ preventScroll: true }));
	};
	let navigateLink = (event: ReactMouseEvent<HTMLDivElement>) => {
		if (
			event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey
			|| event.shiftKey || event.altKey
		) return;
		let target = event.target;
		if (!(target instanceof Element)) return;
		let link = target.closest<HTMLAnchorElement>("a[href]");
		if (!link || link.hasAttribute("download") || (link.target && link.target !== "_self")) return;
		let destination = new URL(link.href, location.href);
		if (destination.origin !== location.origin) return;
		if (
			destination.pathname !== "/"
			&& !/^\/(?:channels|documents|repositories)(?:\/|$)/.test(destination.pathname)
		) return;
		event.preventDefault();
		setDrawerOpen(false);
		navigate(`${destination.pathname}${destination.search}${destination.hash}`);
	};
	let sidebar = (
		<ProjectSidebar
			accountMenu={accountOpen && (
				<div className="navigation-account-menu" role="menu">
					<button onClick={() => void signOut()} role="menuitem" type="button">Sign out</button>
				</div>
			)}
			canCreateDocument={!active || canEditProject(active)}
			creatingProjectIds={creatingProjectIdsForView}
			creatingNewDocument={!!active && creatingProjectIdsForView.has(active.repositoryId)}
			currentDocumentId={currentDocumentId}
			currentResearchWorkspaceId={currentResearchWorkspaceId}
			onAccount={() => setAccountOpen(open => !open)}
			onAddProject={() => showDialog("add")}
			onCollapse={() => {
				setCollapsed(true);
				if (drawerOpen) dismissDrawer();
			}}
			onCreateDocument={project => void createDocument(project)}
			onLoadMore={loadMore}
			onNewResearch={channel => showDialog({ type: "research", channel })}
			onNewDocument={newDocument}
			onRenameDocument={channel => showDialog({ type: "rename", channel })}
			onSearch={() => showDialog("search")}
			projects={projects}
			research={research}
			user={user}
		/>
	);
	let content = (
		<>
			{error !== undefined && (
				<div className="navigation-error" role="alert">
					{error.reason instanceof Error
						? error.reason.message
						: "Could not update navigation."}
					<button
						className="btn btn-sm btn-secondary ml-2"
						onClick={retryError}
						type="button"
					>
						Try again
					</button>
				</div>
			)}
			{children ?? (
				<div className="flex h-full items-center justify-center text-sm text-text-tertiary">
					{navigation?.projects.length === 0
						? "Add a Project to start your first document."
						: "Choose or create a document."}
				</div>
			)}
		</>
	);

	return (
		<NavigationDocument.Provider value={navigationDocument}>
			<div
				className="navigation-shell"
				data-navigation-mode={mode}
				onClickCapture={navigateLink}
			>
				{sidebarVisible && (
					<div className="project-sidebar-frame" style={{ width }}>
						{sidebar}
						<SidebarResizeHandle onResize={resize} width={width} />
					</div>
				)}
				{triggerVisible && (
					<ProjectSidebarExpandButton
						buttonRef={drawerOpener}
						onExpand={() => mode === "drawer" ? setDrawerOpen(true) : setCollapsed(false)}
					/>
				)}
				{mode === "drawer" && drawerOpen && (
					<NavigationDrawer onDismiss={dismissDrawer}>
						{sidebar}
					</NavigationDrawer>
				)}
				{children === undefined
					? (
						<main
							className="navigation-content"
							data-project-sidebar-trigger={triggerVisible || undefined}
						>
							{content}
						</main>
					)
					: (
						<div
							className="navigation-content"
							data-project-sidebar-trigger={triggerVisible || undefined}
						>
							{content}
						</div>
					)}
				{dialog === "add" && (
					<LazyDialogBoundary>
						<Suspense fallback={null}>
							<AddProjectDialog
								added={navigation?.projects ?? []}
								onAdded={project => {
									catalogueRefreshes.current.set(project.repositoryId, Date.now());
									setFocusProjectId(project.repositoryId);
									void refresh();
								}}
								onDismiss={() => setDialog(undefined)}
								userId={user.id}
							/>
						</Suspense>
					</LazyDialogBoundary>
				)}
				{dialog === "search" && (
					<LazyDialogBoundary>
						<Suspense fallback={null}>
							<DocumentSearchDialog
								onDismiss={() => setDialog(undefined)}
								onSelect={navigateToDocument}
								projects={navigation?.projects ?? []}
							/>
						</Suspense>
					</LazyDialogBoundary>
				)}
				{typeof dialog === "object" && dialog.type === "rename" && (
					<LazyDialogBoundary>
						<Suspense fallback={null}>
							<RenameDocumentDialog
								channel={dialog.channel}
								onDismiss={() => setDialog(undefined)}
								onRenamed={renamed}
							/>
						</Suspense>
					</LazyDialogBoundary>
				)}
				{typeof dialog === "object" && dialog.type === "research" && (
					<LazyDialogBoundary>
						<Suspense fallback={null}>
							<NewResearchDialog
								channel={dialog.channel}
								onCreated={workspace => {
									upsertResearchWorkspace(dialog.channel, workspace);
									setDialog(undefined);
									navigate(researchWorkspacePath(
										dialog.channel.repositoryOwner,
										dialog.channel.repositoryName,
										dialog.channel.slug,
										workspace.id,
									));
								}}
								onDismiss={() => setDialog(undefined)}
							/>
						</Suspense>
					</LazyDialogBoundary>
				)}
			</div>
		</NavigationDocument.Provider>
	);
}
