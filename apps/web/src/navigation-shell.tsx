import {
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
import {
	AddProjectDialog,
	DocumentSearchDialog,
	newestDocument,
	RenameDocumentDialog,
} from "./document-actions";
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
import type { ReactNode } from "react";
import type { NavigationMode } from "./navigation-model";

let NewResearchDialog = lazy(() =>
	import("./research-actions").then(module => ({ default: module.NewResearchDialog }))
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

type NavigationFailure = { reason: unknown };

let NavigationDocument = createContext<{
	channel?: Api.Channel;
	onDocumentChanged: (
		documentId: string,
		update: Pick<Api.Channel, "title" | "slug" | "updatedAt">,
	) => void;
	onDocumentLoaded: (channel: Api.Channel) => void;
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
	onDocumentLoaded() {},
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
		route,
		user,
	}: {
		children?: ReactNode;
		route: Route;
		user: Api.User;
	},
) {
	let generation = useRef(0);
	let [navigation, setNavigation] = useState<Api.Navigation>();
	let [error, setError] = useState<NavigationFailure>();
	let [resolvedDocument, setResolvedDocument] = useState<Api.Channel>();
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
	let { loadMore, projects, updateDocument, upsertDocument } = useProjectDocuments(navigation);
	let {
		groups: research,
		refreshResearchChannel,
		refreshResearchWorkspace,
		upsertResearchWorkspace,
	} = useProjectResearch(navigation);
	let currentDocumentId = route.page === "channel"
		? route.id
		: route.page === "document" || route.page === "research"
		? resolvedDocument?.id
		: undefined;
	let currentResearchWorkspaceId = route.page === "research" ? route.workspaceId : undefined;
	let routeKey = route.page === "channel"
		? `${route.page}:${route.id}`
		: route.page === "research"
		? `${route.page}:${route.owner}/${route.repository}/${route.slug}/${route.workspaceId}`
		: route.page === "document"
		? `${route.page}:${route.owner}/${route.repository}/${route.slug}`
		: route.page;
	useEffect(() => setResolvedDocument(undefined), [routeKey]);

	let refresh = useCallback(async () => {
		let request = ++generation.current;
		setError(undefined);
		try {
			let next = await Api.navigation();
			if (request !== generation.current) return;
			setNavigation(next);
		} catch (reason) {
			if (request === generation.current) {
				setError({ reason });
			}
		}
	}, []);
	let documentLoaded = useCallback((channel: Api.Channel) => {
		setResolvedDocument(current =>
			current?.id === channel.id ? newestDocument(current, channel) : channel
		);
		upsertDocument(channel);
		void refresh();
	}, [refresh, upsertDocument]);
	let documentChanged = useCallback((
		documentId: string,
		update: Pick<Api.Channel, "title" | "slug" | "updatedAt">,
	) => {
		updateDocument(documentId, update);
		setResolvedDocument(current =>
			current?.id === documentId && current.updatedAt <= update.updatedAt
				? { ...current, ...update }
				: current
		);
	}, [updateDocument]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	useEffect(() => {
		if (route.page !== "repositories" || !navigation) return;
		let destination = landingDocument(projects, navigation.lastDocumentId);
		if (destination) location.replace(documentDestination(projects, destination));
	}, [navigation, projects, route.page]);

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
		location.assign(documentDestination(projects, documentId, path));
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
			setError({ reason });
		} finally {
			completeProjectCreation(project.repositoryId);
		}
	};

	let active = activeProject(projects, currentDocumentId, resolvedDocument?.repositoryId);
	let currentChannel = projects.flatMap(project => project.documents.channels)
		.find(channel => channel.id === currentDocumentId) ?? resolvedDocument;
	let currentChannelRef = useRef<Api.Channel | undefined>(undefined);
	currentChannelRef.current = currentChannel;
	let newDocument = () => {
		if (active && canEditProject(active)) void createDocument(active);
		else showDialog("add");
	};

	let renamed = (channel: Api.Channel) => {
		upsertDocument(channel);
		setResolvedDocument(current =>
			current?.id === channel.id ? newestDocument(current, channel) : current
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
			setError({ reason });
		}
	};

	let retryError = () => {
		if (!error) return;
		void refresh();
	};
	let dismissDrawer = () => {
		setDrawerOpen(false);
		requestAnimationFrame(() => drawerOpener.current?.focus({ preventScroll: true }));
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
			<div className="navigation-shell" data-navigation-mode={mode}>
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
					<AddProjectDialog
						added={navigation?.projects ?? []}
						onAdded={project => {
							setFocusProjectId(project.repositoryId);
							void refresh();
						}}
						onDismiss={() => setDialog(undefined)}
						userId={user.id}
					/>
				)}
				{dialog === "search" && (
					<DocumentSearchDialog
						onDismiss={() => setDialog(undefined)}
						onSelect={navigateToDocument}
						projects={navigation?.projects ?? []}
					/>
				)}
				{typeof dialog === "object" && dialog.type === "rename" && (
					<RenameDocumentDialog
						channel={dialog.channel}
						onDismiss={() => setDialog(undefined)}
						onRenamed={renamed}
					/>
				)}
				{typeof dialog === "object" && dialog.type === "research" && (
					<Suspense fallback={null}>
						<NewResearchDialog
							channel={dialog.channel}
							onCreated={workspace => {
								upsertResearchWorkspace(dialog.channel, workspace);
								location.assign(researchWorkspacePath(
									dialog.channel.repositoryOwner,
									dialog.channel.repositoryName,
									dialog.channel.slug,
									workspace.id,
								));
							}}
							onDismiss={() => setDialog(undefined)}
						/>
					</Suspense>
				)}
			</div>
		</NavigationDocument.Provider>
	);
}
