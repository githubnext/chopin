import { lazy, Suspense, useCallback, useEffect, useReducer, useRef } from "react";
import { ContentSwapLayer } from "@chopin/editor/content-swap";

import { documentRouteIdentity, transitionDocumentRoute } from "./document-route-swap";
import {
	HostedFailure as Failure,
	HostedLoading as Loading,
	hostedRoute,
	retryableChannelFailure,
} from "./hosted";
import { motionContract } from "./motion-contract";
import { motionImmediately } from "./motion-input";
import { useNavigationDocument } from "./navigation-shell";

import type * as Api from "./api";
import type { ResearchOpener } from "@chopin/editor";
import type { ChildFocusToken } from "./child-history";
import type { ParentFocusTarget } from "./document-workspace-host";
import type {
	DocumentRouteIdentity,
	DocumentRouteIdentitySource,
	DocumentRouteSwap as DocumentRouteSwapState,
} from "./document-route-swap";

// Loaded with the first document route, outside the initial bundle. `hosted.tsx` fetches the
// host alongside this module, so the host arrives no later than it did before the split.
let ChannelWorkspace = lazy(() => import("./channel-workspace"));
let DocumentWorkspaceHost = lazy(() => import("./document-workspace-host"));

type DocumentRoute = DocumentRouteIdentitySource;
type DocumentSource = DocumentRoute;
type DocumentRouteRequest = {
	immediately: boolean;
	key: DocumentRouteIdentity;
	routeKey: DocumentRouteIdentity;
	source: DocumentSource;
};
export type DocumentRouteResolution = {
	canonicalPath: string;
	channel: Api.Channel;
	/** The route identity this resolution answered, which a canonical rename can change. */
	requestKey: DocumentRouteIdentity;
	routeKey: DocumentRouteIdentity;
};
type DocumentRouteLayer = DocumentRouteSwapState<
	DocumentRouteRequest,
	DocumentRouteResolution
>["current"];

function keyedDocumentRoute(
	route: DocumentRoute,
	immediately: boolean,
	alias?: DocumentRouteIdentity,
): DocumentRouteRequest {
	let routeKey = documentRouteIdentity(route);
	let key = alias ?? (route.page === "child"
		? documentRouteIdentity({
			owner: route.owner,
			page: "document",
			repository: route.repository,
			slug: route.parentSlug,
		})
		: documentRouteIdentity(route));
	return {
		immediately,
		key,
		routeKey,
		source: route,
	};
}

export default function DocumentRouteSwap(
	{
		agent,
		childOrigin,
		onCanonicalPath,
		onChildClose,
		onChildOpen,
		onChildClosing,
		onParentRestored,
		route,
		user,
	}: {
		agent: boolean;
		childOrigin: () => Element | undefined;
		onCanonicalPath: (pathname: string) => void;
		onChildClose: (parentId: string, parentPath: string, opener?: ResearchOpener) => void;
		onChildOpen: (path: string) => void;
		onChildClosing: (parentId: string, parentPath: string) => ChildFocusToken;
		onParentRestored: (token: ChildFocusToken, target: ParentFocusTarget) => void;
		route: DocumentRoute;
		user: Api.User;
	},
) {
	let aliases = useRef(new Map<DocumentRouteIdentity, DocumentRouteIdentity>());
	let routeKey = documentRouteIdentity(route);
	let requested = keyedDocumentRoute(route, motionImmediately(), aliases.current.get(routeKey));
	let [state, dispatch] = useReducer(
		transitionDocumentRoute<DocumentRouteRequest, DocumentRouteResolution>,
		{ current: requested },
	);
	let requestedRoute = useRef({ key: requested.key, routeKey: requested.routeKey });
	requestedRoute.current = { key: requested.key, routeKey: requested.routeKey };
	let presentedRequest = state.pending ?? state.current;
	if (requested.key !== presentedRequest.key || requested.routeKey !== presentedRequest.routeKey) {
		dispatch({ route: requested, type: "requested" });
	}
	let layers = [state.previous, state.current, state.pending].filter(
		(layer): layer is DocumentRouteLayer => layer !== undefined,
	);
	let motion = motionContract("route-swap");
	let { onDocumentLoaded, onDocumentRouteSettled } = useNavigationDocument();
	let ready = useCallback((
		key: DocumentRouteIdentity,
		resolution?: DocumentRouteResolution,
	) => {
		if (resolution) aliases.current.set(resolution.routeKey, key);
		dispatch({ key, resolution, type: "ready" });
		if (requestedRoute.current.key === key) {
			onDocumentRouteSettled(requestedRoute.current.routeKey);
		}
	}, [onDocumentRouteSettled]);
	let channelResolved = useCallback((key: DocumentRouteIdentity, pathname: string) => {
		if (requestedRoute.current.key === key) onCanonicalPath(pathname);
	}, [onCanonicalPath]);
	let metadataPath = useCallback((
		key: DocumentRouteIdentity,
		metadataRouteKey: DocumentRouteIdentity,
		pathname: string,
	) => {
		let authority = requestedRoute.current;
		if (key !== authority.key || metadataRouteKey !== authority.routeKey) return;
		let canonicalRoute = hostedRoute(pathname);
		if (canonicalRoute.page === "document" || canonicalRoute.page === "child") {
			aliases.current.set(documentRouteIdentity(canonicalRoute), key);
		}
		onCanonicalPath(pathname);
	}, [onCanonicalPath]);
	let published = useRef<DocumentRouteResolution | undefined>(undefined);
	useEffect(() => {
		let resolution = state.current.resolution;
		// An outgoing route that resolves after a newer request must not canonicalize over it. A
		// parent and its child share a layer, so a child that resolves after a return to its
		// parent arrives on the current layer and is told apart by the route it answered.
		if (!resolution || state.pending || published.current === resolution) return;
		if (resolution.requestKey !== state.current.routeKey) return;
		published.current = resolution;
		onCanonicalPath(resolution.canonicalPath);
		void onDocumentLoaded(resolution.channel, resolution.routeKey);
	}, [
		onCanonicalPath,
		onDocumentLoaded,
		state.current.key,
		state.current.resolution,
		state.current.routeKey,
		state.pending,
	]);

	return (
		<div className="document-route-swap content-swap-stack h-full">
			{layers.map(layer => {
				let source = layer.source;
				return (
					<ContentSwapLayer
						// The incoming route loads unseen and enters once the outgoing one has left.
						// A newer request keeps the outgoing route on screen, so a route the user
						// has already moved past never flashes in.
						active={layer === state.current
							? !state.previous
							: layer === state.previous && !!state.pending}
						className="document-route-layer h-full min-h-0"
						immediately={state.current.immediately}
						key={layer.key}
						motion={motion}
						onClosed={layer.key === state.previous?.key
							? () => dispatch({ key: layer.key, type: "closed" })
							: undefined}
						staged={layer !== state.previous && (layer === state.pending || !!state.previous)}
					>
						{source.page === "document" || source.page === "child"
							? (
								<Suspense fallback={<Loading document label="Opening document…" />}>
									<DocumentWorkspaceHost
										agent={agent}
										childOrigin={childOrigin}
										Failure={Failure}
										layerKey={layer.key}
										Loading={Loading}
										onCanonicalPath={metadataPath}
										onChildClose={onChildClose}
										onChildOpen={onChildOpen}
										onChildClosing={onChildClosing}
										onParentRestored={onParentRestored}
										onReady={ready}
										retryable={retryableChannelFailure}
										route={source}
										user={user}
									/>
								</Suspense>
							)
							: (
								<Suspense fallback={<Loading document label="Opening document…" />}>
									<ChannelWorkspace
										Failure={Failure}
										Loading={Loading}
										onReady={ready}
										onResolved={channelResolved}
										retryable={retryableChannelFailure}
										source={source}
										user={user}
									/>
								</Suspense>
							)}
					</ContentSwapLayer>
				);
			})}
		</div>
	);
}
