import { lazy, Suspense, useCallback, useEffect, useReducer, useRef, useState } from "react";
import { ContentSwapLayer } from "@chopin/editor/content-swap";
import {
	documentsPath,
	parseChildDocumentPath,
	parseDocumentPath,
} from "@chopin/protocol/document-url";

import * as Api from "./api";
import { childFocusTransition } from "./anchored-child-surface";
import { readChannelRecovery, rememberChannel } from "./channel-recovery";
import { childCloseAction, childHistoryState } from "./child-history";
import { documentRouteIdentity, transitionDocumentRoute } from "./document-route-swap";
import { newestDocument } from "./document-actions";
import { motionContract } from "./motion-contract";
import { motionImmediately } from "./motion-input";
import { NavigationShell, useNavigationDocument } from "./navigation-shell";

import type { ComponentType, ReactNode } from "react";
import type { ResearchOpener } from "@chopin/editor";
import type { ChildFocusEvent, ChildFocusState, ChildFocusToken } from "./anchored-child-surface";
import type {
	DocumentRouteIdentity,
	DocumentRouteIdentitySource,
	DocumentRouteSwap as DocumentRouteSwapState,
} from "./document-route-swap";
import type { WorkspacePresentation } from "./workspace-model";

let DocumentWorkspaceHost = lazy(() => import("./document-workspace-host"));

export type HostedWorkspaceProps = {
	room: string;
	handle: string;
	label: string;
	slug: string;
	updatedAt: string;
	descriptionRevision: number;
	description?: string;
	repository: Api.Repository;
	canEdit: boolean;
	canManage: boolean;
	archivedAt?: string;
	agent?: boolean;
	userId: string;
	onMetadataChanged?: (
		metadata: Pick<
			Api.Channel,
			| "archivedAt"
			| "description"
			| "descriptionRevision"
			| "slug"
			| "title"
			| "updatedAt"
		>,
	) => void;
	presentation: WorkspacePresentation;
};

export type HostedRoute =
	| DocumentRouteIdentitySource
	| { page: "repositories" }
	| { page: "repository"; owner: string; repository: string }
	| { page: "missing" };

type DocumentRoute = DocumentRouteIdentitySource;
type ChannelSource = Extract<DocumentRouteIdentitySource, { page: "channel" }>;
type DocumentSource = DocumentRoute;
type DocumentRouteRequest = {
	immediately: boolean;
	key: DocumentRouteIdentity;
	routeKey: DocumentRouteIdentity;
	source: DocumentSource;
};
type DocumentRouteResolution = {
	canonicalPath: string;
	channel: Api.Channel;
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

function decoded(value: string): string | undefined {
	try {
		return decodeURIComponent(value);
	} catch {
		return undefined;
	}
}

export function hostedRoute(pathname: string): HostedRoute {
	if (pathname === "/" || pathname === "") return { page: "repositories" };
	let child = parseChildDocumentPath(pathname);
	if (child) return { page: "child", ...child };
	let document = parseDocumentPath(pathname);
	if (document?.slug) {
		return {
			page: "document",
			owner: document.owner,
			repository: document.repository,
			slug: document.slug,
		};
	}
	if (document) return { page: "repository", ...document };
	let repository = /^\/repositories\/([^/]+)\/([^/]+)\/?$/.exec(pathname);
	if (repository) {
		let owner = decoded(repository[1]!);
		let name = decoded(repository[2]!);
		if (owner && name) return { page: "repository", owner, repository: name };
	}
	let channel = /^\/channels\/([0-9a-f-]{36})\/?$/i.exec(pathname);
	if (channel) return { page: "channel", id: channel[1]!.toLowerCase() };
	return { page: "missing" };
}

export function retryableChannelFailure(error: unknown): boolean {
	return !(error instanceof Api.ApiError)
		|| error.status === 408
		|| error.status === 429
		|| error.status >= 500;
}

function Loading({ label = "Loading" }: { label?: string }) {
	return (
		<div
			className="flex h-full items-center justify-center bg-ground px-4 text-sm text-text-tertiary"
			data-hosted=""
		>
			{label}
		</div>
	);
}

function repositoryHref(repository: { owner: string; name: string }): string {
	return documentsPath(repository.owner, repository.name);
}

function Failure(
	{
		channel,
		error,
		onRetry,
		repository,
	}: {
		channel?: { title?: string; slug?: string };
		error: unknown;
		onRetry?: () => void;
		repository?: Pick<Api.Repository, "owner" | "name" | "fullName">;
	},
) {
	let message = error instanceof Error ? error.message : "Something went wrong";
	return (
		<div className="flex h-full items-center justify-center bg-ground p-4 sm:p-6" data-hosted="">
			<div className="ring-hairline max-w-md rounded-lg bg-page p-4 shadow-resting sm:p-6">
				<h1 className="text-xl font-semibold">Cannot open Chopin</h1>
				<p className="mt-2 text-sm text-text-secondary">{message}</p>
				{channel && (
					<div className="mt-4 min-w-0">
						{channel.title && <p className="break-words text-sm font-medium">{channel.title}</p>}
						{channel.slug && (
							<p className="mt-1 break-all text-sm text-text-tertiary">{channel.slug}</p>
						)}
						{repository && (
							<p className="mt-2 break-words text-sm text-text-secondary">
								{repository.fullName}
							</p>
						)}
					</div>
				)}
				<div className="mt-5 flex flex-wrap gap-2">
					{onRetry && (
						<button className="btn btn-md btn-primary" onClick={onRetry} type="button">
							Try again
						</button>
					)}
					{repository && (
						<a
							className={`btn btn-md ${onRetry ? "btn-secondary" : "btn-primary"}`}
							href={repositoryHref(repository)}
						>
							View {repository.fullName} channels
						</a>
					)}
					<a className="btn btn-md btn-secondary" href="/">Back to repositories</a>
				</div>
			</div>
		</div>
	);
}

export function HostedLogin() {
	let href = githubLoginHref(location.pathname, location.search, location.hash);
	return (
		<div className="grid h-full bg-ground lg:grid-cols-[1.15fr_0.85fr]" data-hosted="">
			<section className="flex items-end bg-text-primary p-6 text-page sm:p-10 lg:p-16">
				<div className="max-w-xl pb-8">
					<p className="text-sm font-semibold text-brand-wash">chopin</p>
					<h1 className="mt-4 text-2xl font-semibold">
						Plan together, in the context of the code.
					</h1>
					<p className="mt-5 max-w-lg text-base text-gray-300">
						A shared document, a visible conversation, and an agent that can read the repository
						without owning the decision.
					</p>
				</div>
			</section>
			<section className="flex items-center justify-center p-6 sm:p-8">
				<div className="w-full max-w-sm">
					<h2 className="text-xl font-semibold">Open your workspace</h2>
					<p className="mt-2 text-sm text-text-secondary">
						Sign in with GitHub to choose a repository and its planning channels.
					</p>
					<a className="btn btn-md btn-primary mt-6 w-full" href={href}>
						Continue with GitHub
					</a>
				</div>
			</section>
		</div>
	);
}

export function githubLoginHref(pathname: string, search = "", hash = ""): string {
	let parameters = new URLSearchParams({ return_to: `${pathname}${search}${hash}` });
	return `/auth/github?${parameters}`;
}

function ChannelWorkspace(
	{ agent, onReady, source, user }: {
		agent: boolean;
		onReady?: (key: DocumentRouteIdentity, resolution?: DocumentRouteResolution) => void;
		source: ChannelSource;
		user: Api.User;
	},
) {
	type LoadedWorkspace = {
		detail: Api.ChannelDetail;
		Workspace: ComponentType<HostedWorkspaceProps>;
	};
	let [loaded, setLoaded] = useState<LoadedWorkspace>();
	let [error, setError] = useState<unknown>();
	let [retry, setRetry] = useState(0);
	let { channel: navigationChannel } = useNavigationDocument();
	let routeKey = documentRouteIdentity(source);
	let recovery = readChannelRecovery(user.id, source.id);

	useEffect(() => {
		let active = true;
		let controller = new AbortController();
		setLoaded(undefined);
		setError(undefined);
		let prepared = import("./document-loader").then(module =>
			module.prepareDocumentLoad({ id: source.id }, controller.signal)
		).then(({ detail, pathname }) => ({ canonicalPath: pathname, detail }));
		prepared = prepared.then(resolved => {
			if (active) {
				rememberChannel(user.id, resolved.detail.channel, resolved.detail.repository);
			}
			return resolved;
		});
		let workspace = import("./room-workspace").then(module => ({
			Workspace: module.RoomWorkspace,
		}));
		Promise.all([prepared, workspace]).then(([resolved, selected]) => {
			if (active) {
				setLoaded({ detail: resolved.detail, ...selected });
				onReady?.(routeKey, {
					canonicalPath: resolved.canonicalPath,
					channel: resolved.detail.channel,
					routeKey,
				});
			}
		}, reason => {
			if (active) {
				setError(reason);
				onReady?.(routeKey);
			}
		});
		return () => {
			active = false;
			controller.abort();
		};
	}, [onReady, retry, routeKey, source, user.id]);
	if (error) {
		return (
			<Failure
				channel={recovery?.channel}
				error={error}
				onRetry={retryableChannelFailure(error)
					? () => {
						setError(undefined);
						setRetry(value => value + 1);
					}
					: undefined}
				repository={recovery?.repository}
			/>
		);
	}
	if (!loaded) return <Loading label="Opening channel..." />;
	let { detail } = loaded;
	let channel = navigationChannel?.id === detail.channel.id
		? newestDocument(detail.channel, navigationChannel)
		: detail.channel;
	let props: HostedWorkspaceProps = {
		agent,
		archivedAt: channel.archivedAt,
		canEdit: !channel.archivedAt && (detail.canEdit || detail.canManage),
		canManage: detail.canManage,
		description: channel.description,
		descriptionRevision: channel.descriptionRevision,
		handle: user.login,
		label: channel.title,
		presentation: { type: "document" },
		slug: channel.slug,
		updatedAt: channel.updatedAt,
		repository: detail.repository,
		room: detail.channel.id,
		userId: user.id,
	};
	let Document = loaded.Workspace;
	return <Document {...props} />;
}

function DocumentRouteSwap(
	{
		agent,
		onCanonicalPath,
		onChildClose,
		onChildClosing,
		onParentRestored,
		route,
		user,
	}: {
		agent: boolean;
		onCanonicalPath: (pathname: string) => void;
		onChildClose: (parentId: string, parentPath: string) => void;
		onChildClosing: (parentId: string, parentPath: string) => ChildFocusToken;
		onParentRestored: (token: ChildFocusToken) => void;
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
	let motion = motionContract("content-swap");
	let ready = useCallback((
		key: DocumentRouteIdentity,
		resolution?: DocumentRouteResolution,
	) => {
		if (resolution) aliases.current.set(resolution.routeKey, key);
		dispatch({ key, resolution, type: "ready" });
	}, []);
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
	let { onDocumentLoaded } = useNavigationDocument();
	let published = useRef<DocumentRouteResolution | undefined>(undefined);
	useEffect(() => {
		let resolution = state.current.resolution;
		if (!resolution || published.current === resolution) return;
		published.current = resolution;
		onCanonicalPath(resolution.canonicalPath);
		void onDocumentLoaded(resolution.channel, resolution.routeKey);
	}, [onCanonicalPath, onDocumentLoaded, state.current.key, state.current.resolution]);

	return (
		<div className="document-route-swap content-swap-stack h-full">
			{layers.map(layer => {
				let source = layer.source;
				return (
					<ContentSwapLayer
						active={layer.key === state.current.key}
						className="document-route-layer h-full min-h-0"
						immediately={state.current.immediately}
						key={layer.key}
						motion={motion}
						onClosed={layer.key === state.previous?.key
							? () => dispatch({ key: layer.key, type: "closed" })
							: undefined}
					>
						{source.page === "document" || source.page === "child"
							? (
								<Suspense fallback={<Loading label="Opening document..." />}>
									<DocumentWorkspaceHost
										agent={agent}
										Failure={Failure}
										layerKey={layer.key}
										Loading={Loading}
										onCanonicalPath={metadataPath}
										onChildClose={onChildClose}
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
								<ChannelWorkspace
									agent={agent}
									onReady={ready}
									source={source}
									user={user}
								/>
							)}
					</ContentSwapLayer>
				);
			})}
		</div>
	);
}

export function HostedApp(
	{ agent, user }: { agent: boolean; user: Api.User },
) {
	let [route, setRoute] = useState(() => hostedRoute(location.pathname));
	let hostedRouteRef = useRef(route);
	hostedRouteRef.current = route;
	let childOpener = useRef<ResearchOpener | undefined>(undefined);
	let childFocus = useRef<ChildFocusState>({ generation: 0 });
	let childFocusFrame = useRef<number | undefined>(undefined);
	let cancelChildFocusFrame = useCallback(() => {
		if (childFocusFrame.current !== undefined) cancelAnimationFrame(childFocusFrame.current);
		childFocusFrame.current = undefined;
	}, []);
	let moveChildFocus = useCallback((event: ChildFocusEvent) => {
		let current = childFocus.current;
		let next = childFocusTransition(current, event);
		if (next !== current && !next.attempt) cancelChildFocusFrame();
		childFocus.current = next;
		return next;
	}, [cancelChildFocusFrame]);
	let childRouteChanged = useCallback((pathname: string) => {
		moveChildFocus({ type: "route", pathname });
	}, [moveChildFocus]);
	let navigate = useCallback((
		destination: string,
		options: { opener?: ResearchOpener; replace?: boolean } = {},
	) => {
		let target = new URL(destination, location.href);
		if (target.origin !== location.origin) {
			moveChildFocus({ type: "cancel" });
			location.assign(target.href);
			return;
		}
		let next = `${target.pathname}${target.search}${target.hash}`;
		let current = `${location.pathname}${location.search}${location.hash}`;
		if (next === current) return;
		childRouteChanged(target.pathname);
		let nextRoute = hostedRoute(target.pathname);
		if (options.replace) history.replaceState(history.state, "", next);
		else {
			let currentRoute = hostedRouteRef.current;
			let siblingChild = nextRoute.page === "child" && currentRoute.page === "child"
				&& nextRoute.owner.toLocaleLowerCase() === currentRoute.owner.toLocaleLowerCase()
				&& nextRoute.repository.toLocaleLowerCase()
					=== currentRoute.repository.toLocaleLowerCase()
				&& nextRoute.parentSlug === currentRoute.parentSlug;
			let inAppChild = nextRoute.page === "child" && currentRoute.page === "document"
				&& nextRoute.owner.toLocaleLowerCase() === currentRoute.owner.toLocaleLowerCase()
				&& nextRoute.repository.toLocaleLowerCase() === currentRoute.repository.toLocaleLowerCase()
				&& nextRoute.parentSlug === currentRoute.slug;
			if (siblingChild || inAppChild) {
				let active = document.activeElement;
				childOpener.current = options.opener
					?? { current: active instanceof HTMLElement ? active : null };
			}
			if (siblingChild) history.replaceState(history.state, "", next);
			else if (inAppChild) {
				history.pushState(
					childHistoryState(history.state, current),
					"",
					next,
				);
			} else history.pushState(null, "", next);
		}
		setRoute(nextRoute);
	}, [childRouteChanged, moveChildFocus]);
	let canonicalPath = useCallback((pathname: string) => {
		if (location.pathname === pathname) return;
		childRouteChanged(pathname);
		history.replaceState(
			history.state,
			"",
			`${pathname}${location.search}${location.hash}`,
		);
		setRoute(hostedRoute(pathname));
	}, [childRouteChanged]);
	let closeChild = useCallback((parentId: string, parentPath: string) => {
		cancelChildFocusFrame();
		let current = childFocus.current;
		let next = moveChildFocus({
			type: "begin",
			opener: childOpener.current,
			parentId,
			parentPath,
		});
		if (next === current) return;
		childOpener.current = undefined;
		let action = childCloseAction(history.state, parentPath);
		if (action.type === "back") history.back();
		else navigate(action.destination, { replace: true });
	}, [cancelChildFocusFrame, moveChildFocus, navigate]);
	let childClosing = useCallback((parentId: string, parentPath: string): ChildFocusToken => {
		cancelChildFocusFrame();
		let next = moveChildFocus({
			type: "begin",
			opener: childOpener.current,
			parentId,
			parentPath,
		});
		childOpener.current = undefined;
		return { generation: next.generation, parentId };
	}, [cancelChildFocusFrame, moveChildFocus]);
	let restoreParentFocus = useCallback((token: ChildFocusToken) => {
		let current = childFocus.current;
		let next = childFocusTransition(current, { type: "restore", token });
		if (next === current || next.attempt?.phase !== "deferred") return;
		childFocus.current = next;
		let attempt = next.attempt;
		cancelChildFocusFrame();
		childFocusFrame.current = requestAnimationFrame(() => {
			childFocusFrame.current = undefined;
			let latest = childFocus.current.attempt;
			if (
				latest?.generation !== attempt.generation
				|| latest.parentId !== attempt.parentId
				|| latest.phase !== "deferred"
				|| location.pathname !== attempt.parentPath
			) return;
			let parent = document.querySelector<HTMLElement>(
				`[data-workspace-room="${CSS.escape(attempt.parentId)}"]`,
			);
			if (!parent?.isConnected || parent.closest("[inert]")) {
				moveChildFocus({ type: "cancel" });
				return;
			}
			let target = attempt.opener?.current;
			if (!target?.isConnected || target.closest("[inert]")) {
				target = parent.querySelector<HTMLElement>(`[data-document-view="plan"] h2`);
			}
			moveChildFocus({ type: "finish", token });
			if (target?.isConnected && !target.closest("[inert]")) {
				target.focus({ preventScroll: true });
			}
		});
	}, [cancelChildFocusFrame, moveChildFocus]);

	useEffect(() => {
		let changed = () => {
			childRouteChanged(location.pathname);
			setRoute(hostedRoute(location.pathname));
		};
		window.addEventListener("popstate", changed);
		return () => {
			window.removeEventListener("popstate", changed);
			moveChildFocus({ type: "cancel" });
			cancelChildFocusFrame();
		};
	}, [cancelChildFocusFrame, childRouteChanged, moveChildFocus]);

	if (route.page === "missing") {
		return <Failure error={new Error("This page does not exist.")} />;
	}
	let workspace: ReactNode;
	switch (route.page) {
		case "repositories":
		case "repository":
			break;
		case "document":
		case "child":
		case "channel":
			workspace = (
				<DocumentRouteSwap
					agent={agent}
					onCanonicalPath={canonicalPath}
					onChildClose={closeChild}
					onChildClosing={childClosing}
					onParentRestored={restoreParentFocus}
					route={route}
					user={user}
				/>
			);
			break;
	}
	return (
		<NavigationShell navigate={navigate} route={route} user={user}>
			{workspace}
		</NavigationShell>
	);
}

export { Failure as HostedFailure, Loading as HostedLoading };
