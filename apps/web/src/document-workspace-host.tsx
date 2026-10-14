import { Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { documentPath } from "@chopin/protocol/document-url";

import * as Api from "./api";
import {
	anchoredChildPaths,
	AnchoredChildSurface,
	rebaseChildHistoryState,
} from "./anchored-child-surface";
import { readDocumentRecovery, rememberChannel } from "./channel-recovery";
import { readChildMotionStyle } from "./child-motion-driver";
import { prepareDocumentLoad } from "./document-loader";
import { updateDocumentMetadata } from "./document-actions";
import { documentRouteIdentity } from "./document-route-swap";
import {
	initialDocumentWorkspaceState,
	transitionDocumentWorkspace,
} from "./document-workspace-state";

import type { ComponentType } from "react";
import type { ResearchOpener } from "@chopin/editor";
import type { ChildFocusToken } from "./anchored-child-surface";
import type { ChildFocusAttempt } from "./child-history";
import type { DocumentWorkspaceAction } from "./document-workspace-state";
import { activeActor } from "./active-actor";
import type { DocumentRouteIdentity } from "./document-route-swap";
import type { HostedRoute } from "./hosted";
import type { HostedWorkspaceProps } from "./hosted";
import type { ChildOpen, WorkspacePresentation } from "./workspace-model";

let roomWorkspaceImport: Promise<typeof import("./room-workspace")> | undefined;
export function loadRoomWorkspace(
	importer: () => Promise<typeof import("./room-workspace")> = () => import("./room-workspace"),
) {
	return roomWorkspaceImport ??= importer().catch(reason => {
		roomWorkspaceImport = undefined;
		throw reason;
	});
}

type DocumentRoute = Extract<HostedRoute, { page: "document" | "child" }>;
type Metadata = Pick<
	Api.Channel,
	| "archivedAt"
	| "description"
	| "descriptionRevision"
	| "slug"
	| "title"
	| "updatedAt"
>;

// Popover menus and the editor's insert listbox render as dialogs, listboxes or comboboxes and
// handle their own Escape; the sheet must not close under them.
let DISMISSIBLE_TARGET =
	'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="menu"], [role="listbox"], [role="dialog"], [role="combobox"]';

function workspaceProps(
	detail: Api.ChannelDetail,
	agent: boolean,
	user: Api.User,
	presentation: WorkspacePresentation,
	onMetadataChanged: (metadata: Metadata) => void,
) {
	let channel = detail.channel;
	return {
		agent,
		archivedAt: channel.archivedAt,
		canEdit: !channel.archivedAt && (detail.canEdit || detail.canManage),
		canManage: detail.canManage,
		description: channel.description,
		descriptionRevision: channel.descriptionRevision,
		handle: activeActor()?.id ?? user.login,
		label: channel.title,
		onMetadataChanged,
		repository: detail.repository,
		room: channel.id,
		slug: channel.slug,
		presentation,
		updatedAt: channel.updatedAt,
		userId: user.id,
	};
}

function parentScroller(host: HTMLElement | null): HTMLElement | null {
	return host?.querySelector<HTMLElement>(
		'[data-document-view="plan"] [data-plan-scroll]:not(.workspace-child-slot *)',
	) ?? null;
}

// How long after a request the outgoing document may wait for this one to sync. Past
// it, the header and body would disagree with the sidebar for too long.
const REVEAL_LIMIT = 200;
const CHILD_SYNC_LIMIT = 8000;

/** Moves focus back into a parent once its child has closed, or nothing when it cannot. */
export type ParentFocusTarget = (attempt: ChildFocusAttempt) => (() => void) | undefined;

// Lives in this lazily loaded host rather than the shell, which only runs it after a close.
function parentFocusTarget(attempt: ChildFocusAttempt): (() => void) | undefined {
	let parent = document.querySelector<HTMLElement>(
		`[data-workspace-room="${CSS.escape(attempt.parentId)}"]`,
	);
	if (!parent?.isConnected || parent.closest("[inert]")) return undefined;
	let opener = attempt.opener?.current;
	let target = opener;
	if (!target?.isConnected || target.closest("[inert]")) {
		target = parent.querySelector<HTMLElement>(`[data-document-view="plan"] h2`);
	}
	return () => {
		if (!target?.isConnected || target.closest("[inert]")) return;
		target.focus({ preventScroll: true });
		// An opener the reader clicked is already in view; a provenance target may not be.
		if (target === opener) target.scrollIntoView({ block: "nearest" });
	};
}

/** Settles true once a child's editor has synced, or false if it never does. */
function childSynced(channelId: string, current: () => boolean): Promise<boolean> {
	let selector = `[data-workspace-room="${CSS.escape(channelId)}"] [data-plan-synced]`;
	let started = performance.now();
	return new Promise(resolve => {
		let check = () => {
			if (!current()) resolve(false);
			else if (document.querySelector(selector)) resolve(true);
			else if (performance.now() - started > CHILD_SYNC_LIMIT) resolve(false);
			else requestAnimationFrame(check);
		};
		check();
	});
}

export default function DocumentWorkspaceHost(
	{
		agent,
		childOrigin,
		Failure,
		layerKey,
		Loading,
		onCanonicalPath,
		onChildClose,
		onChildOpen,
		onChildClosing,
		onParentRestored,
		onReady,
		retryable,
		route,
		user,
	}: {
		agent: boolean;
		childOrigin?: () => Element | undefined;
		Failure: ComponentType<{
			channel?: { title?: string; slug?: string };
			error: unknown;
			onRetry?: () => void;
			repository?: Pick<Api.Repository, "owner" | "name" | "fullName">;
		}>;
		layerKey: DocumentRouteIdentity;
		Loading: ComponentType<{ document?: boolean; label?: string }>;
		onCanonicalPath: (
			key: DocumentRouteIdentity,
			routeKey: DocumentRouteIdentity,
			pathname: string,
		) => void;
		onChildClose: (parentId: string, parentPath: string, opener?: ResearchOpener) => void;
		onChildOpen: (path: string) => void;
		onChildClosing: (parentId: string, parentPath: string) => ChildFocusToken;
		onParentRestored: (token: ChildFocusToken, target: ParentFocusTarget) => void;
		onReady: (
			key: DocumentRouteIdentity,
			resolution?: {
				canonicalPath: string;
				channel: Api.Channel;
				requestKey: DocumentRouteIdentity;
				routeKey: DocumentRouteIdentity;
			},
		) => void;
		retryable: (error: unknown) => boolean;
		route: DocumentRoute;
		user: Api.User;
	},
) {
	let [state, setState] = useState(initialDocumentWorkspaceState);
	let [RoomWorkspace, setRoomWorkspace] = useState<ComponentType<HostedWorkspaceProps>>();
	let [workspaceError, setWorkspaceError] = useState<unknown>();
	let [workspaceRetry, setWorkspaceRetry] = useState(0);
	useEffect(() => {
		let active = true;
		// This starts beside the metadata request below, before the document is ready to render.
		void loadRoomWorkspace().then(
			module => {
				if (active) setRoomWorkspace(() => module.RoomWorkspace);
			},
			reason => {
				if (active) setWorkspaceError(reason);
			},
		);
		return () => {
			active = false;
		};
	}, [workspaceRetry]);
	let stateRef = useRef(state);
	stateRef.current = state;
	let send = useCallback((action: DocumentWorkspaceAction) => {
		let next = transitionDocumentWorkspace(stateRef.current, action);
		stateRef.current = next;
		setState(next);
		return next;
	}, []);
	let loaded = state.status === "ready" ? state.loaded : undefined;
	let routeRef = useRef(route);
	routeRef.current = route;
	let routeKey = documentRouteIdentity(route);
	// Canonical slugs are aliases of the request already in flight, not new documents.
	let requestAliases = useRef(new Map<DocumentRouteIdentity, DocumentRouteIdentity>());
	let loadKey = requestAliases.current.get(routeKey) ?? routeKey;
	let error = state.error;
	let presentation = state.presentation;
	let previousPresentation = useRef(presentation);
	let closingFocus = useRef<ChildFocusToken | undefined>(undefined);
	let parentScrollTop = useRef<number | undefined>(undefined);
	let parentSurface = useRef<HTMLDivElement>(null);
	let openRequest = useRef(0);
	useEffect(() => () => void (openRequest.current += 1), []);
	// The card's key follows the child request, so canonical renames never remount
	// it, and it outlives the route while the card closes.
	let childKey = useRef<string | undefined>(undefined);
	if (route.page === "child") childKey.current = loadKey;

	useEffect(() => {
		let active = true;
		let controller = new AbortController();
		let requestedRoute = routeRef.current;
		let requestedAt = performance.now();
		send({ type: "loading" });
		let currentState = stateRef.current;
		let current = currentState.status === "ready" ? currentState.loaded : undefined;
		if (requestedRoute.page === "child" && current && !current.child) {
			let scroller = parentScroller(parentSurface.current);
			if (scroller) parentScrollTop.current = scroller.scrollTop;
		}
		let address = {
			owner: requestedRoute.owner,
			repository: requestedRoute.repository,
			slug: requestedRoute.page === "child" ? requestedRoute.childSlug : requestedRoute.slug,
			...(requestedRoute.page === "child"
				? { parentSlug: requestedRoute.parentSlug }
				: {}),
		};
		void prepareDocumentLoad(
			address,
			controller.signal,
			Api,
			requestedRoute.page === "child" && !current
				? parent => {
					if (!active) return;
					rememberChannel(user.id, parent.channel, parent.repository);
					send({ parent, route: requestedRoute, type: "parent-ready" });
				}
				: undefined,
		).then(prepared => {
			if (!active) return;
			let parent = prepared.parent ?? prepared.detail;
			let child = prepared.parent ? prepared.detail : undefined;
			let latest = stateRef.current;
			if (latest.status === "ready" && latest.loaded.parent.channel.id === parent.channel.id) {
				parent = {
					...parent,
					channel: updateDocumentMetadata(parent.channel, latest.loaded.parent.channel),
				};
			}
			rememberChannel(user.id, parent.channel, parent.repository);
			if (child) rememberChannel(user.id, child.channel, child.repository);
			send({ child, parent, route: routeRef.current, type: "ready" });
			let routeKey = child
				? documentRouteIdentity({
					childSlug: child.channel.slug,
					owner: child.repository.owner,
					page: "child",
					parentSlug: parent.channel.slug,
					repository: child.repository.name,
				})
				: documentRouteIdentity({
					owner: parent.repository.owner,
					page: "document",
					repository: parent.repository.name,
					slug: parent.channel.slug,
				});
			requestAliases.current.set(routeKey, loadKey);
			let paths = anchoredChildPaths({
				owner: parent.repository.owner,
				repository: parent.repository.name,
				slug: parent.channel.slug,
			}, child?.channel.slug);
			let resolution = {
				canonicalPath: paths.child ?? paths.parent,
				channel: (child ?? parent).channel,
				requestKey: documentRouteIdentity(routeRef.current),
				routeKey,
			};
			// The outgoing document stays on screen until this one has synced, briefly.
			let synced = `[data-workspace-room="${
				CSS.escape(resolution.channel.id)
			}"] [data-plan-synced]`;
			let reveal = () => {
				if (!active) return;
				if (
					parentSurface.current?.closest(".document-route-layer")?.querySelector(synced)
					|| performance.now() - requestedAt > REVEAL_LIMIT
				) {
					onReady(layerKey, resolution);
				} else {
					requestAnimationFrame(reveal);
				}
			};
			reveal();
		}, reason => {
			if (active) {
				send({ error: reason, type: "failed" });
				onReady(layerKey);
			}
		});
		return () => {
			active = false;
			controller.abort();
		};
	}, [layerKey, loadKey, onReady, send, state.retry, user.id]);

	useLayoutEffect(() => {
		if (!loaded || parentScrollTop.current === undefined) return;
		let scroller = parentScroller(parentSurface.current);
		if (scroller) scroller.scrollTop = parentScrollTop.current;
		if (presentation === "closed") parentScrollTop.current = undefined;
	}, [loaded, presentation]);

	useLayoutEffect(() => {
		let previous = previousPresentation.current;
		previousPresentation.current = presentation;
		if (previous !== "closing" || presentation !== "closed") return;
		let token = closingFocus.current;
		closingFocus.current = undefined;
		let current = stateRef.current;
		if (
			token
			&& current.status === "ready"
			&& current.loaded.parent.channel.id === token.parentId
		) {
			onParentRestored(token, parentFocusTarget);
		}
	}, [onParentRestored, presentation]);

	useEffect(() => {
		let current = stateRef.current;
		let action = { route, type: "route" } as const;
		let next = transitionDocumentWorkspace(current, action);
		if (route.page === "child") {
			closingFocus.current = undefined;
		} else if (
			current.status === "ready"
			&& current.presentation === "open"
			&& next.status === "ready"
			&& next.presentation === "closing"
		) {
			closingFocus.current = onChildClosing(
				current.loaded.parent.channel.id,
				documentPath(
					current.loaded.parent.repository.owner,
					current.loaded.parent.repository.name,
					current.loaded.parent.channel.slug,
				),
			);
		} else if (!(next.status === "ready" && next.presentation === "closing")) {
			closingFocus.current = undefined;
		}
		send(action);
	}, [onChildClosing, route, send]);

	let childClosed = useCallback(() => {
		if (stateRef.current.presentation === "closing") send({ type: "closed" });
	}, [send]);
	let motion = readChildMotionStyle();

	useEffect(() => {
		if (presentation !== "open") return;
		let closeOnEscape = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
			// Escape dismisses the innermost thing first: a field gives up focus, then the next one closes.
			let target = event.target instanceof Element ? event.target : undefined;
			// Root Chat and the top bar stay live beside the child, so Escape there is theirs alone.
			let rootWorkspace = document.querySelector(".workspace-child-slot")?.closest(
				".workspace-root",
			);
			if (
				target && rootWorkspace?.contains(target) && !target.closest(".workspace-document-stack")
			) {
				return;
			}
			if (target?.closest(DISMISSIBLE_TARGET)) {
				event.preventDefault();
				document.querySelector<HTMLElement>(".anchored-child-card:last-of-type")?.focus({
					preventScroll: true,
				});
				return;
			}
			if (document.querySelector(".workspace-child-slot[hidden]")) return;
			event.preventDefault();
			let current = stateRef.current;
			if (current.status === "ready") {
				onChildClose(
					current.loaded.parent.channel.id,
					documentPath(
						current.loaded.parent.repository.owner,
						current.loaded.parent.repository.name,
						current.loaded.parent.channel.slug,
					),
				);
			}
		};
		window.addEventListener("keydown", closeOnEscape);
		return () => window.removeEventListener("keydown", closeOnEscape);
	}, [onChildClose, presentation]);

	let metadataChanged = useCallback((kind: "parent" | "child", metadata: Metadata) => {
		if (documentRouteIdentity(routeRef.current) !== routeKey) return;
		let current = stateRef.current;
		if (current.status === "empty") return;
		let target = kind === "parent" ? current.loaded.parent : current.loaded.child;
		if (!target) return;
		let updatedState = send({ kind, metadata, type: "metadata" });
		if (updatedState.status === "empty") return;
		let updated = updatedState.loaded;
		let route = routeRef.current;
		let paths = anchoredChildPaths(
			{
				owner: updated.parent.repository.owner,
				repository: updated.parent.repository.name,
				slug: updated.parent.channel.slug,
			},
			// Parent metadata can arrive before the requested child detail finishes loading.
			route.page === "child" ? updated.child?.channel.slug ?? route.childSlug : undefined,
		);
		let pathname = route.page === "child" ? paths.child! : paths.parent;
		if (kind === "parent" && routeRef.current.page === "child") {
			history.replaceState(rebaseChildHistoryState(history.state, paths.parent), "");
		}
		let canonicalRoute = route.page === "child"
			? {
				...route,
				parentSlug: updated.parent.channel.slug,
				childSlug: updated.child?.channel.slug ?? route.childSlug,
			}
			: { ...route, slug: updated.parent.channel.slug };
		let canonicalKey = documentRouteIdentity(canonicalRoute);
		requestAliases.current.set(canonicalKey, loadKey);
		onCanonicalPath(layerKey, routeKey, pathname);
		if (canonicalKey !== routeKey && (route.page === "document" || updated.child)) {
			onReady(layerKey, {
				canonicalPath: pathname,
				channel: route.page === "child" ? updated.child!.channel : updated.parent.channel,
				requestKey: canonicalKey,
				routeKey: canonicalKey,
			});
		}
	}, [layerKey, loadKey, onCanonicalPath, onReady, routeKey, send]);
	let parentMetadataChanged = useCallback(
		(metadata: Metadata) => metadataChanged("parent", metadata),
		[metadataChanged],
	);
	let childMetadataChanged = useCallback(
		(metadata: Metadata) => metadataChanged("child", metadata),
		[metadataChanged],
	);

	let retryFailure = error && retryable(error)
		? () => send({ type: "retry" })
		: undefined;
	let requestedSlug = route.page === "child" ? route.childSlug : route.slug;
	let recovery = readDocumentRecovery(user.id, route.owner, route.repository, requestedSlug);
	let requestedRepository = {
		fullName: `${route.owner}/${route.repository}`,
		name: route.repository,
		owner: route.owner,
	};
	if (error && !loaded) {
		return (
			<Failure
				channel={recovery?.channel ?? { slug: requestedSlug }}
				error={error}
				onRetry={retryFailure}
				repository={recovery?.repository ?? requestedRepository}
			/>
		);
	}
	if (!loaded) {
		return <Loading document label="Opening document…" />;
	}
	if (workspaceError) {
		return (
			<Failure
				error={workspaceError}
				onRetry={() => {
					setWorkspaceError(undefined);
					setWorkspaceRetry(value => value + 1);
				}}
			/>
		);
	}
	if (!RoomWorkspace) {
		return <Loading document label="Opening document…" />;
	}

	let parentPath = anchoredChildPaths(
		{
			owner: loaded.parent.repository.owner,
			repository: loaded.parent.repository.name,
			slug: loaded.parent.channel.slug,
		},
		loaded.child?.channel.slug,
	).parent;
	let childVisible = presentation !== "closed";
	let childLabel = loaded.child?.channel.title ?? (route.page === "child" ? route.childSlug : "");
	let closeChild = () => onChildClose(loaded.parent.channel.id, parentPath);
	let openChild: ChildOpen = async channelId => {
		let request = ++openRequest.current;
		let rootId = loaded.parent.channel.id;
		// A newer request, a different root, or a closed child makes this one stale.
		let current = () => {
			let now = stateRef.current;
			return request === openRequest.current && now.status === "ready"
				&& now.loaded.parent.channel.id === rootId;
		};
		let detail = await Api.channel(channelId).catch(() => undefined);
		// Only a child of this root opens here; the stored parentage is authoritative.
		if (!current() || !detail || detail.channel.parentChannelId !== rootId) return false;
		let path = anchoredChildPaths(
			{
				owner: loaded.parent.repository.owner,
				repository: loaded.parent.repository.name,
				slug: loaded.parent.channel.slug,
			},
			detail.channel.slug,
		).child;
		if (!path) return false;
		onChildOpen(path);
		// During a switch from another child, `loaded.child` still names the old one until the
		// new one is ready, so liveness is the request token alone.
		return childSynced(channelId, current);
	};
	let child = loaded.child
		? (
			<Suspense fallback={<Loading label="Opening child document…" />}>
				<RoomWorkspace
					{...workspaceProps(
						loaded.child,
						agent,
						user,
						{
							label: loaded.child.channel.title,
							onClose: closeChild,
							parent: {
								id: loaded.parent.channel.id,
								label: loaded.parent.channel.title,
								onReturn: opener => onChildClose(loaded.parent.channel.id, parentPath, opener),
							},
							type: "child",
						},
						childMetadataChanged,
					)}
					key={loaded.child.channel.id}
				/>
			</Suspense>
		)
		: route.page === "child" && presentation === "open"
		? error
			? <Failure error={error} onRetry={retryFailure} />
			: <Loading label="Opening child document…" />
		: undefined;
	let layer = (
		<AnchoredChildSurface
			entries={[{
				id: childKey.current ?? "child",
				label: childLabel,
				node: child,
			}]}
			focusKey={loaded.child?.channel.id ?? (route.page === "child"
				? `${route.parentSlug}/${route.childSlug}`
				: undefined)}
			motion={motion}
			onClosed={childClosed}
			origin={childOrigin}
			presentation={presentation}
		/>
	);
	let nested = {
		child: layer,
		// Chat's focus follows the open child and lapses as soon as it starts to close.
		childId: presentation === "open" ? loaded.child?.channel.id : undefined,
		childRequestKey: childKey.current ?? loadKey,
		childState: presentation === "closing" ? "closing" as const : "open" as const,
		motion,
		onChildClose: closeChild,
		onChildOpen: openChild,
		path: [
			{ id: loaded.parent.channel.id, label: loaded.parent.channel.title },
			{ id: loaded.child?.channel.id ?? "child", label: childLabel },
		],
		type: "parent-with-child" as const,
	};
	return (
		<div
			className="anchored-child-host"
			data-child-presentation={presentation}
			key={loaded.parent.channel.id}
			ref={parentSurface}
		>
			<Suspense fallback={<Loading document label="Opening document…" />}>
				<RoomWorkspace
					{...workspaceProps(
						loaded.parent,
						agent,
						user,
						childVisible ? nested : { onChildOpen: openChild, type: "document" as const },
						parentMetadataChanged,
					)}
					key={loaded.parent.channel.id}
				/>
			</Suspense>
		</div>
	);
}
