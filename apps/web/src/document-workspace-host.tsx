import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { documentPath } from "@chopin/protocol/document-url";

import * as Api from "./api";
import {
	anchoredChildPaths,
	AnchoredChildSurface,
	rebaseChildHistoryState,
} from "./anchored-child-surface";
import { readDocumentRecovery, rememberChannel } from "./channel-recovery";
import { prepareDocumentLoad } from "./document-loader";
import { documentRouteIdentity } from "./document-route-swap";
import {
	initialDocumentWorkspaceState,
	transitionDocumentWorkspace,
} from "./document-workspace-state";

import type { ComponentType } from "react";
import type { ChildFocusToken } from "./anchored-child-surface";
import type { DocumentWorkspaceAction } from "./document-workspace-state";
import type { DocumentRouteIdentity } from "./document-route-swap";
import type { HostedRoute } from "./hosted";
import type { WorkspaceSurface } from "./workspace-model";

let RoomWorkspace = lazy(() =>
	import("./room-workspace").then(module => ({ default: module.RoomWorkspace }))
);

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

function workspaceProps(
	detail: Api.ChannelDetail,
	agent: boolean,
	user: Api.User,
	surface: WorkspaceSurface,
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
		handle: user.login,
		label: channel.title,
		onMetadataChanged,
		repository: detail.repository,
		room: channel.id,
		slug: channel.slug,
		surface,
		updatedAt: channel.updatedAt,
		userId: user.id,
	};
}

export default function DocumentWorkspaceHost(
	{
		agent,
		Failure,
		layerKey,
		Loading,
		onCanonicalPath,
		onChildClose,
		onChildClosing,
		onParentRestored,
		onReady,
		retryable,
		route,
		user,
	}: {
		agent: boolean;
		Failure: ComponentType<{
			channel?: { title?: string; slug?: string };
			error: unknown;
			onRetry?: () => void;
			repository?: Pick<Api.Repository, "owner" | "name" | "fullName">;
		}>;
		layerKey: DocumentRouteIdentity;
		Loading: ComponentType<{ label?: string }>;
		onCanonicalPath: (
			key: DocumentRouteIdentity,
			routeKey: DocumentRouteIdentity,
			pathname: string,
		) => void;
		onChildClose: (parentPath: string) => void;
		onChildClosing: (parentId: string, parentPath: string) => ChildFocusToken;
		onParentRestored: (token: ChildFocusToken) => void;
		onReady: (
			key: DocumentRouteIdentity,
			resolution?: {
				canonicalPath: string;
				channel: Api.Channel;
				routeKey: DocumentRouteIdentity;
			},
		) => void;
		retryable: (error: unknown) => boolean;
		route: DocumentRoute;
		user: Api.User;
	},
) {
	let [state, setState] = useState(initialDocumentWorkspaceState);
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
	let error = state.error;
	let presentation = state.presentation;
	let previousPresentation = useRef(presentation);
	let closingFocus = useRef<ChildFocusToken | undefined>(undefined);
	let parentScrollTop = useRef<number | undefined>(undefined);
	let parentSurface = useRef<HTMLDivElement>(null);

	useEffect(() => {
		let active = true;
		let controller = new AbortController();
		let requestedRoute = routeRef.current;
		send({ type: "loading" });
		let currentState = stateRef.current;
		let current = currentState.status === "ready" ? currentState.loaded : undefined;
		if (requestedRoute.page === "child" && current && !current.child) {
			let scroller = parentSurface.current?.querySelector<HTMLElement>("[data-plan-scroll]");
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
		void (async () => {
			if (requestedRoute.page === "child" && !current) {
				let prepared = await prepareDocumentLoad({
					owner: requestedRoute.owner,
					repository: requestedRoute.repository,
					slug: requestedRoute.parentSlug,
				}, controller.signal);
				if (!active) return;
				let parent = prepared.parent ?? prepared.detail;
				rememberChannel(user.id, parent.channel, parent.repository);
				send({ parent, route: requestedRoute, type: "parent-ready" });
			}
			return await prepareDocumentLoad(address, controller.signal);
		})().then(prepared => {
			if (!prepared) return;
			if (!active) return;
			let parent = prepared.parent ?? prepared.detail;
			let child = prepared.parent ? prepared.detail : undefined;
			rememberChannel(user.id, parent.channel, parent.repository);
			if (child) rememberChannel(user.id, child.channel, child.repository);
			send({ child, parent, route: requestedRoute, type: "ready" });
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
			onReady(layerKey, {
				canonicalPath: prepared.pathname,
				channel: (child ?? parent).channel,
				routeKey,
			});
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
	}, [layerKey, onReady, routeKey, send, state.retry, user.id]);

	useLayoutEffect(() => {
		if (!loaded || parentScrollTop.current === undefined) return;
		let scroller = parentSurface.current?.querySelector<HTMLElement>("[data-plan-scroll]");
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
			onParentRestored(token);
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

	useEffect(() => {
		if (presentation !== "closing") return;
		let timer = window.setTimeout(() => {
			send({ type: "closed" });
		}, 190);
		return () => window.clearTimeout(timer);
	}, [presentation, send]);

	useEffect(() => {
		if (presentation !== "open") return;
		let closeOnEscape = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || event.defaultPrevented) return;
			event.preventDefault();
			let current = stateRef.current;
			if (current.status === "ready") {
				onChildClose(documentPath(
					current.loaded.parent.repository.owner,
					current.loaded.parent.repository.name,
					current.loaded.parent.channel.slug,
				));
			}
		};
		window.addEventListener("keydown", closeOnEscape);
		return () => window.removeEventListener("keydown", closeOnEscape);
	}, [onChildClose, presentation]);

	let metadataChanged = useCallback((kind: "parent" | "child", metadata: Metadata) => {
		let current = stateRef.current;
		if (current.status === "empty") return;
		let target = kind === "parent" ? current.loaded.parent : current.loaded.child;
		if (!target) return;
		let updatedState = send({ kind, metadata, type: "metadata" });
		if (updatedState.status === "empty") return;
		let updated = updatedState.loaded;
		let paths = anchoredChildPaths(
			{
				owner: updated.parent.repository.owner,
				repository: updated.parent.repository.name,
				slug: updated.parent.channel.slug,
			},
			updated.child?.channel.slug,
		);
		let pathname = routeRef.current.page === "child" && updated.child
			? paths.child!
			: paths.parent;
		if (kind === "parent" && routeRef.current.page === "child") {
			history.replaceState(rebaseChildHistoryState(history.state, paths.parent), "");
		}
		onCanonicalPath(layerKey, documentRouteIdentity(routeRef.current), pathname);
	}, [layerKey, onCanonicalPath, send]);
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
		return (
			<Loading label={route.page === "document" ? "Opening channel..." : "Opening document..."} />
		);
	}

	let parentPath = anchoredChildPaths(
		{
			owner: loaded.parent.repository.owner,
			repository: loaded.parent.repository.name,
			slug: loaded.parent.channel.slug,
		},
		loaded.child?.channel.slug,
	).parent;
	let parent = (
		<Suspense fallback={<Loading label="Opening parent document..." />}>
			<RoomWorkspace
				{...workspaceProps(loaded.parent, agent, user, "document", parentMetadataChanged)}
				key={loaded.parent.channel.id}
			/>
		</Suspense>
	);
	let child = loaded.child
		? (
			<Suspense fallback={<Loading label="Opening child document..." />}>
				<RoomWorkspace
					{...workspaceProps(loaded.child, agent, user, "child", childMetadataChanged)}
					key={loaded.child.channel.id}
				/>
			</Suspense>
		)
		: route.page === "child" && presentation === "open"
		? error
			? <Failure error={error} onRetry={retryFailure} />
			: <Loading label="Opening child document..." />
		: undefined;
	return (
		<AnchoredChildSurface
			child={child}
			childLabel={loaded.child?.channel.title ?? (route.page === "child"
				? route.childSlug
				: "")}
			focusKey={loaded.child?.channel.id ?? (route.page === "child"
				? `${route.parentSlug}/${route.childSlug}`
				: undefined)}
			onClose={() => onChildClose(parentPath)}
			parent={parent}
			parentLabel={loaded.parent.channel.title}
			parentRef={parentSurface}
			presentation={presentation}
			key={loaded.parent.channel.id}
		/>
	);
}
