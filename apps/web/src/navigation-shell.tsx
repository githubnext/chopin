import {
	Component,
	createContext,
	lazy,
	Suspense,
	useCallback,
	useContext,
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { useTransitionPresence } from "@chopin/editor/transition-presence";
import { documentPath } from "@chopin/protocol/document-url";

import * as Api from "./api";
import { forgetChannel } from "./channel-recovery";
import { newestDocument, updateDocumentMetadata } from "./document-actions";
import { WorkspaceNotice } from "./workspace-notice";
import { documentRouteIdentity } from "./document-route-swap";
import type { DocumentAction } from "./document-actions-menu";
import type { NoticeOptions } from "./navigation-notice";
import { motionContract } from "./motion-contract";
import { useMenuDismissal } from "./menu-dismissal";
import { motionImmediately } from "./motion-input";
import {
	activeProject,
	canManageProject,
	documentCreationTarget,
	documentDestination,
	isDocumentWorkspaceRoute,
	landingDocument,
	NAVIGATION_MEDIA,
	navigationMode,
	researchChildNavigation,
} from "./navigation-model";
import {
	ProjectSidebarExpandButton,
	ProjectSidebarLoading,
	SIDEBAR_MAX,
	SIDEBAR_MIN,
	SIDEBAR_STORAGE_KEY,
} from "./project-sidebar-chrome";
import { clearRepositoryCache } from "./repository-cache";
import { NavigationError } from "./navigation-error";
import { useProjectDocuments } from "./use-project-documents";
import { useDocumentCreation } from "./use-document-creation";
import { requestTitleEdit } from "./title-edit";

import type { Research } from "@chopin/protocol";
import type { ResearchOpener } from "@chopin/editor";
import type { CSSProperties, MouseEvent as ReactMouseEvent, ReactNode } from "react";
import type { DocumentMetadata } from "./document-actions";
import type { DocumentRouteIdentity } from "./document-route-swap";
import type { ShortcutActions } from "./global-shortcuts";
import type { NavigationMode, NavigationRoute } from "./navigation-model";

export type Navigate = (
	destination: string,
	options?: { opener?: ResearchOpener; replace?: boolean },
) => void;

class LazyDialogBoundary extends Component<
	{ children: ReactNode; onFailure: () => void },
	{ failed: boolean }
> {
	override state = { failed: false };

	static getDerivedStateFromError() {
		return { failed: true };
	}

	override componentDidCatch() {
		this.props.onFailure();
	}

	override render() {
		if (!this.state.failed) return <Suspense fallback={null}>{this.props.children}</Suspense>;
		return null;
	}
}

let NavigationNotice = lazy(() => import("./navigation-notice-view"));
let NavigationDrawer = lazy(() =>
	import("./navigation-drawer").then(module => ({ default: module.NavigationDrawer }))
);

class SidebarFeatureBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
	override state = { failed: false };

	static getDerivedStateFromError() {
		return { failed: true };
	}

	override render() {
		return this.state.failed ? null : <Suspense fallback={null}>{this.props.children}</Suspense>;
	}
}

let ProjectSidebar = lazy(() =>
	import("./project-sidebar").then(module => ({ default: module.ProjectSidebar }))
);
let SidebarDecisionCounts = lazy(() => import("./sidebar-decision-counts"));
let SidebarResizeHandle = lazy(() =>
	import("./sidebar-resize-handle").then(module => ({ default: module.SidebarResizeHandle }))
);
let EmptyWorkspace = lazy(() =>
	import("./empty-workspace").then(module => ({ default: module.EmptyWorkspace }))
);
let AddProjectDialog = lazy(() =>
	import("./add-project-dialog").then(module => ({ default: module.AddProjectDialog }))
);
let NewDocumentDialog = lazy(() =>
	import("./new-document-dialog").then(module => ({ default: module.NewDocumentDialog }))
);
let DocumentSearchDialog = lazy(() =>
	import("./document-search-dialog").then(module => ({ default: module.DocumentSearchDialog }))
);
let DeleteDocumentDialog = lazy(() =>
	import("./delete-document-dialog").then(module => ({ default: module.DeleteDocumentDialog }))
);
let KeyboardShortcutsDialog = lazy(() =>
	import("./keyboard-shortcuts-dialog").then(module => ({
		default: module.KeyboardShortcutsDialog,
	}))
);

type NavigationFailure = { reason: unknown; retry?: "refresh" | "visit" };

let NavigationDocument = createContext<{
	channel?: Api.Channel;
	onDocumentChanged: (
		documentId: string,
		update: DocumentMetadata,
	) => void;
	onDocumentAction: (documentId: string, action: DocumentAction) => void;
	onDocumentDeleted: (documentId: string) => void;
	onDocumentLoaded: (channel: Api.Channel, routeKey: DocumentRouteIdentity) => Promise<void>;
	onDocumentRouteSettled: (routeKey: DocumentRouteIdentity) => void;
	onProjectReveal: (repositoryId: string) => void;
	onRepositoryAccessChanged: () => void;
	onResearchChildOpen: (
		parentId: string,
		child: Research.ReadyChild,
		opener: ResearchOpener,
	) => void;
	onResearchChildPublished: (parentId: string, child: Research.ReadyChild) => void;
}>({
	onDocumentChanged() {},
	onDocumentAction() {},
	onDocumentDeleted() {},
	async onDocumentLoaded() {},
	onDocumentRouteSettled() {},
	onProjectReveal() {},
	onRepositoryAccessChanged() {},
	onResearchChildOpen() {},
	onResearchChildPublished() {},
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

export function NavigationShell(
	{
		children,
		navigate,
		navigationRevision,
		route,
		user,
	}: {
		children?: ReactNode;
		navigate: Navigate;
		navigationRevision: number;
		route: NavigationRoute;
		user: Api.User;
	},
) {
	let [navigation, setNavigation] = useState<Api.Navigation>();
	let [countsReady, setCountsReady] = useState(false);
	useEffect(() => {
		let frame = requestAnimationFrame(() => {
			frame = requestAnimationFrame(() => setCountsReady(true));
		});
		return () => cancelAnimationFrame(frame);
	}, []);
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
		routeKey: DocumentRouteIdentity;
	}>();
	let resolvedDocumentRef = useRef(resolvedDocument);
	resolvedDocumentRef.current = resolvedDocument;
	let [collapsed, setCollapsed] = useState(() =>
		localStorage.getItem(`${SIDEBAR_STORAGE_KEY}:collapsed`) === "true"
	);
	let [drawerOpen, setDrawerOpen] = useState(false);
	let drawerOpener = useRef<HTMLButtonElement>(null);
	let [catalogueMode, setCatalogueMode] = useState<"active" | "archived">("active");
	let [dialog, setDialog] = useState<
		| "add"
		| "new"
		| "search"
		| "shortcuts"
		| { channel: Api.Channel; type: "delete" }
	>();
	let [accountOpen, setAccountOpen] = useState(false);
	let [dialogLoadFailed, setDialogLoadFailed] = useState(false);
	let [settledRouteKey, setSettledRouteKey] = useState<DocumentRouteIdentity>();
	let [focusProjectId, setFocusProjectId] = useState<string>();
	let [notice, showNotice] = useState<NoticeOptions>();
	let [reveal, setReveal] = useState<{ id: string; nonce: number }>();
	let [width, resize] = useSidebarWidth();
	let mode = useNavigationMode();
	let immediateMotion = motionImmediately();
	let previousMode = useRef(mode);
	let modeChanged = previousMode.current !== mode;
	useLayoutEffect(() => {
		previousMode.current = mode;
	}, [mode]);
	let sidebarMotion = motionContract("sidebar");
	let sidebarVisible = mode === "inline" && !collapsed;
	let sidebarPresence = useTransitionPresence(
		sidebarVisible ? true : undefined,
		sidebarMotion.closeDuration,
		immediateMotion || modeChanged,
	);
	let drawerPresence = useTransitionPresence(
		mode === "drawer" && drawerOpen ? true : undefined,
		180,
		immediateMotion,
	);
	let dialogPresence = useTransitionPresence(dialog, 150, immediateMotion);
	let accountWrap = useRef<HTMLDivElement>(null);
	let accountTrigger = useRef<HTMLButtonElement>(null);
	let accountMenuId = useId();
	let closeAccount = (restoreFocus: boolean) => {
		setAccountOpen(false);
		if (restoreFocus) accountTrigger.current?.focus();
	};
	useMenuDismissal(accountOpen, [accountWrap], closeAccount);
	useEffect(() => {
		if (!accountOpen) return;
		let frame = requestAnimationFrame(() => {
			accountWrap.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
		});
		return () => cancelAnimationFrame(frame);
	}, [accountOpen]);
	let accountPresence = useTransitionPresence(
		accountOpen ? true : undefined,
		150,
		immediateMotion,
	);
	let dialogMotion = dialogPresence.phase === "closed" ? undefined : dialogPresence;
	let presentedDialog = dialogMotion?.value;
	let triggerVisible = !sidebarVisible && !drawerOpen;
	let resyncDecisions = useRef<(repositoryId: string) => void>(() => {});
	let {
		beginTotalRequest,
		loadMore,
		projects,
		refreshProject,
		removeDocument,
		updateDecisionCounts,
		updateDecisionSnapshot,
		updateDocument,
		upsertDocument,
	} = useProjectDocuments(
		navigation,
		catalogueMode === "archived",
		repositoryId => resyncDecisions.current(repositoryId),
	);
	let routeKey = isDocumentWorkspaceRoute(route)
		? documentRouteIdentity(route)
		: route.page === "repository"
		? `repository:${route.owner}/${route.repository}`
		: route.page;
	let currentRouteKey = useRef(routeKey);
	currentRouteKey.current = routeKey;
	let currentRoute = useRef(route);
	currentRoute.current = route;
	let resolvedChannel = resolvedDocument?.routeKey === routeKey
		? resolvedDocument.channel
		: undefined;
	let routedChannel = route.page === "document" || route.page === "child"
		? projects.flatMap(project => project.documents.channels).find(channel =>
			channel.repositoryOwner.toLocaleLowerCase() === route.owner.toLocaleLowerCase()
			&& channel.repositoryName.toLocaleLowerCase() === route.repository.toLocaleLowerCase()
			&& channel.slug === (route.page === "child" ? route.childSlug : route.slug)
		)
		: undefined;
	let currentDocumentId = route.page === "channel"
		? route.id
		: routedChannel?.id ?? resolvedChannel?.id;
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
	let clearLastDocument = useCallback((documentId: string) => {
		if (latestVisitedDocument.current === documentId) latestVisitedDocument.current = undefined;
		let current = navigationRef.current;
		if (current?.lastDocumentId !== documentId) return;
		let next = { ...current };
		delete next.lastDocumentId;
		visitRevision.current++;
		navigationRef.current = next;
		setNavigation(next);
	}, []);
	let documentLoaded = useCallback(async (
		channel: Api.Channel,
		loadedRouteKey: DocumentRouteIdentity,
	) => {
		let resolved = resolvedDocumentRef.current;
		let loaded = {
			channel: resolved?.routeKey === loadedRouteKey && resolved.channel.id === channel.id
				? newestDocument(resolved.channel, channel)
				: channel,
			routeKey: loadedRouteKey,
		};
		resolvedDocumentRef.current = loaded;
		setResolvedDocument(loaded);
		upsertDocument(loaded.channel);
		if (loaded.channel.archivedAt) {
			clearLastDocument(channel.id);
			return;
		}
		let visited = visitTail.current.then(() => Api.visitDocument(channel.id));
		visitTail.current = visited.catch(() => {});
		try {
			await visited;
		} catch (reason) {
			if (currentRouteKey.current === loadedRouteKey) setError({ reason, retry: "visit" });
			return;
		}
		setError(current => current?.retry === "visit" ? undefined : current);
		if (
			resolvedDocumentRef.current?.channel.id === channel.id
			&& resolvedDocumentRef.current.channel.archivedAt
		) return;
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
	}, [clearLastDocument, refresh, upsertDocument]);
	let documentChanged = useCallback((
		documentId: string,
		update: DocumentMetadata,
	) => {
		let current = resolvedDocumentRef.current;
		let accepted: Api.Channel | undefined;
		if (current?.channel.id === documentId) {
			accepted = updateDocumentMetadata(current.channel, update);
			let next = accepted === current.channel ? current : { ...current, channel: accepted };
			resolvedDocumentRef.current = next;
			setResolvedDocument(next);
			upsertDocument(next.channel);
			let activeRoute = currentRoute.current;
			if (
				current.routeKey === currentRouteKey.current
				&& (activeRoute.page === "channel"
					|| activeRoute.page === "document")
			) {
				let path = documentPath(
					accepted.repositoryOwner,
					accepted.repositoryName,
					accepted.slug,
				);
				if (location.pathname !== path) {
					history.replaceState(null, "", `${path}${location.search}${location.hash}`);
				}
			}
		} else updateDocument(documentId, update);
		if (Object.hasOwn(update, "archivedAt")) {
			let archived = accepted ? accepted.archivedAt : update.archivedAt;
			if (archived) clearLastDocument(documentId);
		}
	}, [clearLastDocument, updateDocument, upsertDocument]);

	useEffect(() => {
		void refresh(false);
	}, [refresh]);

	useEffect(() => {
		localStorage.setItem(`${SIDEBAR_STORAGE_KEY}:collapsed`, String(collapsed));
	}, [collapsed]);

	useEffect(() => {
		if (mode === "inline") setDrawerOpen(false);
	}, [mode]);

	useEffect(() => {
		if (
			route.page !== "channel" && route.page !== "document" && route.page !== "child"
			&& navigation?.projects.length === 0
		) {
			showDialog("add");
		}
	}, [navigation?.projects.length, route.page]);

	let navigateToDocument = (documentId: string, path?: string) => {
		setError(undefined);
		setDialog(undefined);
		setDrawerOpen(false);
		navigate(documentDestination(projects, documentId, path));
	};

	let creation = useDocumentCreation({
		routeKey,
		navigationRevision,
		onCreated: upsertDocument,
		onNavigate: navigateToDocument,
		onAccessChanged: () => void refresh(),
	});
	useEffect(() => {
		if (route.page !== "repositories" || !navigation) return;
		// Catalogue updates from earlier creations must not compete with an explicit creation.
		if (creation.pending.size > 0 || creation.error) return;
		let destination = landingDocument(projects, navigation.lastDocumentId);
		if (destination) navigate(documentDestination(projects, destination), { replace: true });
	}, [creation.error, creation.pending.size, navigate, navigation, projects, route.page]);
	let createDocument = (project: Api.NavigationProject) => {
		let current = navigationRef.current?.projects.find(value =>
			value.repositoryId === project.repositoryId
		);
		if (current) void creation.create(current);
	};
	let retryProject = navigation?.projects.find(project =>
		project.repositoryId === creation.error?.project.repositoryId
		&& project.available && canManageProject(project)
	);
	let documentRouteSettled = useCallback((key: DocumentRouteIdentity) => {
		if (currentRouteKey.current !== key) return;
		setSettledRouteKey(key);
		creation.settled(key);
	}, [creation.settled]);

	let active = activeProject(projects, currentDocumentId, resolvedChannel?.repositoryId);
	let creationTarget = documentCreationTarget(
		navigation?.projects,
		active,
		isDocumentWorkspaceRoute(route) && settledRouteKey !== routeKey,
	);
	let currentChannel = projects.flatMap(project => project.documents.channels)
		.find(channel => channel.id === currentDocumentId) ?? resolvedChannel;
	let currentChannelRef = useRef<Api.Channel | undefined>(undefined);
	currentChannelRef.current = currentChannel;
	let knownChannelsRef = useRef(new Map<string, Api.Channel>());
	knownChannelsRef.current = new Map(
		[
			...projects.flatMap(project => project.documents.channels),
			...(resolvedChannel ? [resolvedChannel] : []),
		].map(channel => [channel.id, channel]),
	);
	let currentDocumentIdRef = useRef(currentDocumentId);
	currentDocumentIdRef.current = currentDocumentId;
	let projectsRef = useRef(projects);
	projectsRef.current = projects;
	let refreshProjectRef = useRef(refreshProject);
	refreshProjectRef.current = refreshProject;
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
	}, [active, refresh, refreshProject]);
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
		if (creationTarget.type === "loading") return;
		if (creationTarget.type === "project") createDocument(creationTarget.project);
		else showDialog("new");
	};

	let showDialog = useCallback((next: NonNullable<typeof dialog>) => {
		setDialogLoadFailed(false);
		setDrawerOpen(false);
		setAccountOpen(false);
		setDialog(next);
	}, []);
	let acceptChannel = useCallback((channel: Api.Channel) => {
		if (channel.archivedAt) {
			clearLastDocument(channel.id);
		}
		upsertDocument(channel);
		let current = resolvedDocumentRef.current;
		if (current?.channel.id !== channel.id) return;
		let next = { ...current, channel: newestDocument(current.channel, channel) };
		resolvedDocumentRef.current = next;
		setResolvedDocument(next);
	}, [clearLastDocument, upsertDocument]);
	let documentDeleted = useCallback((documentId: string) => {
		let channel = knownChannelsRef.current.get(documentId);
		if (channel) forgetChannel(user.id, channel);
		removeDocument(documentId);
		clearLastDocument(documentId);
		let current = resolvedDocumentRef.current;
		if (current?.channel.id === documentId) {
			resolvedDocumentRef.current = undefined;
			setResolvedDocument(undefined);
		}
		setDialog(currentDialog =>
			typeof currentDialog === "object" && currentDialog.channel.id === documentId
				? undefined
				: currentDialog
		);
		if (currentDocumentIdRef.current === documentId) navigate("/", { replace: true });
	}, [clearLastDocument, navigate, removeDocument, user.id]);
	let documentAction = useCallback((channel: Api.Channel, action: DocumentAction) => {
		setDrawerOpen(false);
		setAccountOpen(false);
		if (action === "copy-link") {
			let href =
				new URL(documentDestination(projectsRef.current, channel.id), location.origin).href;
			void import("./copy-link").then(module => module.copyLink(href, showNotice));
			return;
		}
		if (action === "rename") {
			requestTitleEdit(channel.id, "rename");
			if (currentDocumentIdRef.current !== channel.id) {
				navigate(documentDestination(projectsRef.current, channel.id));
			}
			return;
		}
		if (action === "delete") {
			showDialog({ type: "delete", channel });
			return;
		}
		setError(undefined);
		let acceptTotal = beginTotalRequest(channel.repositoryId);
		let mutation = action === "archive"
			? Api.archiveChannel(channel.id)
			: Api.restoreChannel(channel.id);
		void mutation.then(detail => {
			acceptChannel(detail.channel);
			if (action === "archive") acceptTotal(detail.unansweredDecisions);
			if (action === "restore") setCatalogueMode("active");
			else {
				showNotice({
					message: `Archived ${detail.channel.title}`,
					action: {
						label: "Undo",
						onAction: () => {
							void Api.restoreChannel(detail.channel.id).then(restored => {
								acceptChannel(restored.channel);
								requestAnimationFrame(() =>
									(document.querySelector<HTMLElement>(
										`[data-project-sidebar] [data-document-id="${restored.channel.id}"] .project-sidebar-document-link`,
									)
										?? document.querySelector<HTMLElement>(
											"header button[aria-label^='Actions for ']",
										))
										?.focus({ preventScroll: true })
								);
							}, reason => setError({ reason }));
						},
					},
					duration: 8000,
				});
			}
		}, reason => {
			setError({ reason });
		});
	}, [acceptChannel, beginTotalRequest, navigate, showDialog, showNotice]);
	let workspaceDocumentAction = useCallback((documentId: string, action: DocumentAction) => {
		let channel = knownChannelsRef.current.get(documentId);
		if (channel) documentAction(channel, action);
	}, [documentAction]);
	let researchChildOpen = useCallback((
		parentId: string,
		child: Research.ReadyChild,
		opener: ResearchOpener,
	) => {
		let channel = knownChannelsRef.current.get(parentId);
		if (!channel) return;
		setError(undefined);
		setDialog(undefined);
		setDrawerOpen(false);
		let target = researchChildNavigation(channel, child, opener);
		navigate(target.destination, { opener: target.opener });
	}, [navigate]);
	let researchChildPublished = useCallback((parentId: string, _child: Research.ReadyChild) => {
		let channel = knownChannelsRef.current.get(parentId);
		if (!channel) return;
		let entry = projectsRef.current.find(value =>
			value.project.repositoryId === channel.repositoryId
		);
		if (!entry?.project.available) return;
		refreshProjectRef.current(entry.project);
	}, []);
	let repositoryAccessChanged = useCallback(() => {
		void refresh();
	}, [refresh]);
	let projectReveal = useCallback((id: string) => {
		setCollapsed(false);
		if (mode === "drawer") setDrawerOpen(true);
		setReveal(current => ({ id, nonce: (current?.nonce ?? 0) + 1 }));
	}, [mode]);
	let navigationDocument = useMemo(() => ({
		channel: currentChannel,
		onDocumentAction: workspaceDocumentAction,
		onDocumentChanged: documentChanged,
		onDocumentDeleted: documentDeleted,
		onDocumentLoaded: documentLoaded,
		onDocumentRouteSettled: documentRouteSettled,
		onProjectReveal: projectReveal,
		onRepositoryAccessChanged: repositoryAccessChanged,
		onResearchChildOpen: researchChildOpen,
		onResearchChildPublished: researchChildPublished,
	}), [
		currentChannel,
		documentChanged,
		documentDeleted,
		documentLoaded,
		documentRouteSettled,
		projectReveal,
		repositoryAccessChanged,
		researchChildOpen,
		researchChildPublished,
		workspaceDocumentAction,
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
		if (error.retry === "visit" && currentChannelRef.current && isDocumentWorkspaceRoute(route)) {
			void documentLoaded(currentChannelRef.current, documentRouteIdentity(route));
		} else void refresh();
	};
	let dismissDrawer = () => {
		setDrawerOpen(false);
		requestAnimationFrame(() => drawerOpener.current?.focus({ preventScroll: true }));
	};
	let dismissDialog = () => setDialog(undefined);
	let [sidebarShortcut, setSidebarShortcut] = useState<string>();
	let shortcutActions = useRef<ShortcutActions>({});
	shortcutActions.current = {
		search: () => showDialog("search"),
		"new-document": newDocument,
		shortcuts: () => showDialog("shortcuts"),
		"toggle-sidebar": () => {
			if (mode === "drawer") return setDrawerOpen(true);
			if (collapsed) return setCollapsed(false);
			let inside = document.activeElement?.closest(".project-sidebar-frame");
			setCollapsed(true);
			if (inside) requestAnimationFrame(() => drawerOpener.current?.focus({ preventScroll: true }));
		},
	};
	// The listener and its registry load after first paint; the shell only names its actions.
	useEffect(() => {
		let stop: (() => void) | undefined;
		let live = true;
		void import("./global-shortcuts").then(module => {
			if (!live) return;
			stop = module.listenForShortcuts(() => shortcutActions.current);
			setSidebarShortcut(module.shortcutHint("toggle-sidebar"));
		});
		return () => {
			live = false;
			stop?.();
		};
	}, []);
	let collapseSidebar = () => {
		setCollapsed(true);
		dismissDrawer();
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
		// Lexical's clickable-link listener is attached at the editor root. Stop
		// the event before it reaches that root after this shell has claimed an app route.
		event.stopPropagation();
		setDrawerOpen(false);
		navigate(`${destination.pathname}${destination.search}${destination.hash}`);
	};
	let sidebarLoading = <ProjectSidebarLoading onCollapse={collapseSidebar} user={user} />;
	let sidebar = (
		<Suspense fallback={sidebarLoading}>
			<ProjectSidebar
				accountMenu={accountPresence.phase !== "closed" && {
					className: accountPresence.className,
					closing: accountPresence.phase === "closing",
					onDismiss: () => closeAccount(false),
					onShortcuts: () => showDialog("shortcuts"),
					onSignOut: () => void signOut(),
				}}
				accountMenuId={accountMenuId}
				accountMenuOpen={accountOpen}
				accountTriggerRef={accountTrigger}
				accountWrapRef={accountWrap}
				canCreateDocument={creationTarget.type !== "loading"}
				pendingCreations={creation.pending}
				newDocumentPhase={creationTarget.type === "loading"
					? "loading"
					: creationTarget.type === "project"
					? creation.pending.get(creationTarget.project.repositoryId)
					: undefined}
				currentDocumentId={currentDocumentId}
				onAccount={() => setAccountOpen(open => !open)}
				focusProjectId={focusProjectId}
				onAddProject={() => showDialog("add")}
				onFocusedProject={() => setFocusProjectId(undefined)}
				onRevealed={() => setReveal(undefined)}
				reveal={reveal}
				onCollapse={collapseSidebar}
				onCreateDocument={project => void createDocument(project)}
				onDocumentAction={documentAction}
				onLoadMore={loadMore}
				onNewDocument={newDocument}
				onSearch={() => showDialog("search")}
				onCatalogueModeChange={setCatalogueMode}
				projects={projects}
				catalogueMode={catalogueMode}
				user={user}
			/>
		</Suspense>
	);
	let unknownRepository = route.page === "repository" && navigation
			&& !navigation.projects.some(project =>
				project.repositoryOwner.toLowerCase() === route.owner.toLowerCase()
				&& project.repositoryName.toLowerCase() === route.repository.toLowerCase()
			)
		? `${route.owner}/${route.repository}`
		: undefined;
	let content = (
		<>
			{dialogLoadFailed && (
				<NavigationError
					message="Could not load this dialog."
					onRetry={() => location.reload()}
					retryLabel="Reload"
				/>
			)}
			{notice && (
				<Suspense>
					<NavigationNotice notice={notice} show={showNotice} />
				</Suspense>
			)}
			{!sidebarVisible && !drawerOpen && presentedDialog !== "new" && creation.pending.size > 0 && (
				<div className="navigation-creation-status" role="status">
					{[...creation.pending].map(([id, phase]) => (
						<p key={id}>
							{phase === "creating" ? "Creating document…" : "Opening document…"}{" "}
							{navigation?.projects.find(project => project.repositoryId === id)?.repositoryName}
						</p>
					))}
				</div>
			)}
			{creation.error && presentedDialog !== "new" && (
				<NavigationError
					message={creation.error.message}
					onRetry={retryProject ? () => void createDocument(retryProject) : undefined}
				/>
			)}
			{error !== undefined && (
				<NavigationError
					message={error.reason instanceof Error
						? error.reason.message
						: "Could not update navigation."}
					onRetry={error.retry ? retryError : undefined}
				/>
			)}
			<div className="navigation-body">
				{children ?? (unknownRepository
					? (
						<WorkspaceNotice
							actions={
								<button
									className="btn btn-md btn-primary"
									onClick={() => showDialog("add")}
									type="button"
								>
									Add project
								</button>
							}
							body="Add it to open its documents."
							title={`${unknownRepository} isn't one of your projects`}
						/>
					)
					: (
						<Suspense fallback={null}>
							<EmptyWorkspace
								disabled={creationTarget.type === "loading" || creation.pending.size > 0}
								hasProjects={navigation?.projects.length !== 0}
								onAddProject={() => showDialog("add")}
								onNewDocument={newDocument}
							/>
						</Suspense>
					))}
			</div>
		</>
	);

	return (
		<NavigationDocument.Provider value={navigationDocument}>
			{countsReady && (
				<SidebarFeatureBoundary>
					<SidebarDecisionCounts
						archived={catalogueMode === "archived"}
						onCounts={updateDecisionCounts}
						onSnapshot={updateDecisionSnapshot}
						priorityRepositoryId={active?.repositoryId}
						projects={projects}
						refreshProject={refreshProject}
						resync={resyncDecisions}
					/>
				</SidebarFeatureBoundary>
			)}
			<div
				className="navigation-shell"
				data-navigation-mode={mode}
				onClickCapture={navigateLink}
			>
				{sidebarPresence.phase !== "closed" && (
					<div
						aria-hidden={sidebarPresence.phase === "closing" ? "true" : undefined}
						className={`project-sidebar-frame ${sidebarMotion.className} ${sidebarPresence.className}`}
						inert={sidebarPresence.phase === "closing"}
						style={{ "--project-sidebar-width": `${width}px` } as CSSProperties}
					>
						<div className="project-sidebar-motion-content">{sidebar}</div>
						<SidebarFeatureBoundary>
							<SidebarResizeHandle onResize={resize} width={width} />
						</SidebarFeatureBoundary>
					</div>
				)}
				{triggerVisible && (
					<ProjectSidebarExpandButton
						buttonRef={drawerOpener}
						onExpand={() => mode === "drawer" ? setDrawerOpen(true) : setCollapsed(false)}
						shortcut={sidebarShortcut}
					/>
				)}
				{drawerPresence.phase !== "closed" && (
					<LazyDialogBoundary
						onFailure={() => {
							dismissDrawer();
							setDialogLoadFailed(true);
						}}
					>
						<NavigationDrawer motion={drawerPresence} onDismiss={dismissDrawer}>
							{sidebar}
						</NavigationDrawer>
					</LazyDialogBoundary>
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
				{dialogMotion && presentedDialog === "add" && (
					<LazyDialogBoundary onFailure={() => setDialogLoadFailed(true)}>
						<AddProjectDialog
							added={navigation?.projects ?? []}
							motion={dialogMotion}
							onAdded={project => {
								catalogueRefreshes.current.set(project.repositoryId, Date.now());
								setFocusProjectId(project.repositoryId);
								setCollapsed(false);
								if (mode === "drawer") {
									setDrawerOpen(true);
								}
								void refresh();
							}}
							onDismiss={dismissDialog}
							userId={user.id}
						/>
					</LazyDialogBoundary>
				)}
				{dialogMotion && presentedDialog === "new" && (
					<LazyDialogBoundary onFailure={() => setDialogLoadFailed(true)}>
						<Suspense fallback={null}>
							<NewDocumentDialog
								error={creation.error?.message}
								motion={dialogMotion}
								onAddProject={() =>
									showDialog("add")}
								onCreate={createDocument}
								onDismiss={() => {
									setDialog(undefined);
									if (mode === "drawer") {
										requestAnimationFrame(() => drawerOpener.current?.focus());
									}
								}}
								onRetry={retryProject ? () => createDocument(retryProject) : undefined}
								pending={creation.pending}
								projects={navigation?.projects ?? []}
							/>
						</Suspense>
					</LazyDialogBoundary>
				)}
				{dialogMotion && presentedDialog === "search" && (
					<LazyDialogBoundary onFailure={() => setDialogLoadFailed(true)}>
						<DocumentSearchDialog
							includeArchived={catalogueMode === "archived"}
							motion={dialogMotion}
							onDismiss={dismissDialog}
							onSelect={navigateToDocument}
							projects={navigation?.projects ?? []}
							source={projects}
							userId={user.id}
						/>
					</LazyDialogBoundary>
				)}
				{dialogMotion && presentedDialog === "shortcuts" && (
					<LazyDialogBoundary onFailure={() => setDialogLoadFailed(true)}>
						<KeyboardShortcutsDialog motion={dialogMotion} onDismiss={dismissDialog} />
					</LazyDialogBoundary>
				)}
				{dialogMotion && typeof presentedDialog === "object"
					&& presentedDialog.type === "delete" && (
					<LazyDialogBoundary onFailure={() => setDialogLoadFailed(true)}>
						<DeleteDocumentDialog
							channel={presentedDialog.channel}
							motion={dialogMotion}
							onDeleted={() =>
								documentDeleted(presentedDialog.channel.id)}
							onDismiss={dismissDialog}
						/>
					</LazyDialogBoundary>
				)}
			</div>
		</NavigationDocument.Provider>
	);
}
