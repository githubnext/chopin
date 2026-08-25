import { lazy, Suspense, useCallback, useEffect, useReducer, useRef, useState } from "react";
import { ContentSwapLayer } from "@chopin/editor/content-swap";
import {
	childDocumentPath,
	documentPath,
	documentsPath,
	parseChildDocumentPath,
	parseDocumentPath,
	parseResearchWorkspacePath,
	researchWorkspacePath,
} from "@chopin/protocol/document-url";

import * as Api from "./api";
import { childCloseAction, childHistoryState } from "./anchored-child-surface";
import { readChannelRecovery, readDocumentRecovery, rememberChannel } from "./channel-recovery";
import { documentRouteIdentity, transitionDocumentRoute } from "./document-route-swap";
import { newestDocument } from "./document-actions";
import { motionContract } from "./motion-contract";
import { motionImmediately } from "./motion-input";
import { NavigationShell, useNavigationDocument } from "./navigation-shell";

import type { ComponentType, ReactNode } from "react";
import type {
	DocumentRouteIdentity,
	DocumentRouteIdentitySource,
	DocumentRouteSwap as DocumentRouteSwapState,
} from "./document-route-swap";
import type { WorkspaceSurface } from "./workspace-model";

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
	surface?: WorkspaceSurface;
};

export type HostedRoute =
	| DocumentRouteIdentitySource
	| { page: "repositories" }
	| { page: "repository"; owner: string; repository: string }
	| { page: "missing" };

type DocumentRoute = Exclude<DocumentRouteIdentitySource, { page: "research" }>;
type ChannelSource = DocumentRouteIdentitySource;
type DocumentSource = DocumentRoute;
type DocumentRouteRequest = {
	immediately: boolean;
	key: DocumentRouteIdentity;
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
	let research = parseResearchWorkspacePath(pathname);
	if (research) return { page: "research", ...research };
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

export function validatedChildPath(
	child: Api.ChannelDetail,
	parent: Api.ChannelDetail,
): string {
	let sameRepository = child.repository.id === parent.repository.id
		&& child.channel.repositoryId === child.repository.id
		&& parent.channel.repositoryId === parent.repository.id;
	if (
		!child.channel.parentChannelId
		|| child.channel.parentChannelId !== parent.channel.id
		|| parent.channel.parentChannelId
		|| !sameRepository
		|| !parent.channel.slug
		|| !child.channel.slug
	) {
		throw new Api.ApiError("Child document not found", 404);
	}
	return childDocumentPath(
		child.repository.owner,
		child.repository.name,
		parent.channel.slug,
		child.channel.slug,
	);
}

type DocumentReaders = {
	channel: (id: string, signal?: AbortSignal) => Promise<Api.ChannelDetail>;
	document: (
		owner: string,
		repository: string,
		slug: string,
		signal?: AbortSignal,
	) => Promise<Api.ChannelDetail>;
};

export async function prepareDocumentLoad(
	address:
		| { id: string }
		| {
			owner: string;
			repository: string;
			slug: string;
			parentSlug?: string;
		},
	signal: AbortSignal,
	readers: DocumentReaders = Api,
): Promise<{ detail: Api.ChannelDetail; parent?: Api.ChannelDetail; pathname: string }> {
	if ("id" in address) {
		let detail = await readers.channel(address.id, signal);
		if (!detail.channel.parentChannelId) {
			return {
				detail,
				pathname: documentPath(
					detail.repository.owner,
					detail.repository.name,
					detail.channel.slug,
				),
			};
		}
		let parent = await readers.channel(detail.channel.parentChannelId, signal);
		return { detail, parent, pathname: validatedChildPath(detail, parent) };
	}
	if (address.parentSlug) {
		let [detail, parent] = await Promise.all([
			readers.document(address.owner, address.repository, address.slug, signal),
			readers.document(address.owner, address.repository, address.parentSlug, signal),
		]);
		return { detail, parent, pathname: validatedChildPath(detail, parent) };
	}
	let detail = await readers.document(
		address.owner,
		address.repository,
		address.slug,
		signal,
	);
	if (detail.channel.parentChannelId) {
		let parent = await readers.channel(detail.channel.parentChannelId, signal);
		return { detail, parent, pathname: validatedChildPath(detail, parent) };
	}
	return {
		detail,
		pathname: documentPath(
			detail.repository.owner,
			detail.repository.name,
			detail.channel.slug,
		),
	};
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

function canonicalize(pathname: string): void {
	if (location.pathname === pathname) return;
	history.replaceState(history.state, "", `${pathname}${location.search}${location.hash}`);
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
	type LoadedWorkspace =
		| {
			kind: "document";
			detail: Api.ChannelDetail;
			Workspace: ComponentType<HostedWorkspaceProps>;
		}
		| {
			kind: "research";
			detail: Api.ChannelDetail;
			Workspace: ComponentType<HostedWorkspaceProps & { workspaceId: string }>;
			workspaceId: string;
		};
	let [loaded, setLoaded] = useState<LoadedWorkspace>();
	let [error, setError] = useState<unknown>();
	let [retry, setRetry] = useState(0);
	let { channel: navigationChannel } = useNavigationDocument();
	let routeKey = documentRouteIdentity(source);
	let recovery;
	switch (source.page) {
		case "channel":
			recovery = readChannelRecovery(user.id, source.id);
			break;
		case "child":
			recovery = readDocumentRecovery(
				user.id,
				source.owner,
				source.repository,
				source.childSlug,
			);
			break;
		case "document":
		case "research":
			recovery = readDocumentRecovery(
				user.id,
				source.owner,
				source.repository,
				source.slug,
			);
			break;
	}

	useEffect(() => {
		let active = true;
		let controller = new AbortController();
		setLoaded(undefined);
		setError(undefined);
		let prepared = source.page === "research"
			? Api.document(
				source.owner,
				source.repository,
				source.slug,
				controller.signal,
			).then(detail => ({
				canonicalPath: researchWorkspacePath(
					detail.repository.owner,
					detail.repository.name,
					detail.channel.slug,
					source.workspaceId,
				),
				detail,
			}))
			: prepareDocumentLoad(
				source.page === "channel"
					? { id: source.id }
					: {
						owner: source.owner,
						parentSlug: source.page === "child" ? source.parentSlug : undefined,
						repository: source.repository,
						slug: source.page === "child" ? source.childSlug : source.slug,
					},
				controller.signal,
			).then(({ detail, pathname }) => ({ canonicalPath: pathname, detail }));
		prepared = prepared.then(resolved => {
			if (active) {
				rememberChannel(user.id, resolved.detail.channel, resolved.detail.repository);
			}
			return resolved;
		});
		let workspace;
		switch (source.page) {
			case "channel":
			case "child":
			case "document":
				workspace = import("./room-workspace").then(module => ({
					kind: "document" as const,
					Workspace: module.RoomWorkspace,
				}));
				break;
			case "research":
				workspace = import("./research-workspace").then(module => ({
					kind: "research" as const,
					Workspace: module.ResearchWorkspace,
					workspaceId: source.workspaceId,
				}));
				break;
		}
		Promise.all([prepared, workspace]).then(([resolved, selected]) => {
			if (active) {
				setLoaded({ detail: resolved.detail, ...selected } as LoadedWorkspace);
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
		let requestedRepository;
		let requestedSlug;
		switch (source.page) {
			case "channel":
				break;
			case "child":
				requestedRepository = {
					fullName: `${source.owner}/${source.repository}`,
					name: source.repository,
					owner: source.owner,
				};
				requestedSlug = source.childSlug;
				break;
			case "document":
			case "research":
				requestedRepository = {
					fullName: `${source.owner}/${source.repository}`,
					name: source.repository,
					owner: source.owner,
				};
				requestedSlug = source.slug;
				break;
		}
		return (
			<Failure
				channel={recovery?.channel ?? (requestedSlug ? { slug: requestedSlug } : undefined)}
				error={error}
				onRetry={retryableChannelFailure(error)
					? () => {
						setError(undefined);
						setRetry(value => value + 1);
					}
					: undefined}
				repository={recovery?.repository ?? requestedRepository}
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
		slug: channel.slug,
		updatedAt: channel.updatedAt,
		repository: detail.repository,
		room: detail.channel.id,
		userId: user.id,
	};
	if (loaded.kind === "research") {
		let Research = loaded.Workspace;
		return <Research {...props} workspaceId={loaded.workspaceId} />;
	}
	let Document = loaded.Workspace;
	return <Document {...props} />;
}

function ActiveChannelWorkspace(
	{ agent, source, user }: { agent: boolean; source: ChannelSource; user: Api.User },
) {
	let { onDocumentLoaded } = useNavigationDocument();
	let ready = useCallback((key: DocumentRouteIdentity, resolution?: DocumentRouteResolution) => {
		if (!resolution) return;
		canonicalize(resolution.canonicalPath);
		void onDocumentLoaded(resolution.channel, key);
	}, [onDocumentLoaded]);
	return <ChannelWorkspace agent={agent} onReady={ready} source={source} user={user} />;
}

function DocumentRouteLayerWorkspace(
	{
		agent,
		layerKey,
		onCanonicalPath,
		onChildClose,
		onParentRestored,
		onReady,
		source,
		user,
	}: {
		agent: boolean;
		layerKey: DocumentRouteIdentity;
		onCanonicalPath: (key: DocumentRouteIdentity, pathname: string) => void;
		onChildClose: (parentPath: string) => void;
		onParentRestored: (parentId: string) => void;
		onReady: (key: DocumentRouteIdentity, resolution?: DocumentRouteResolution) => void;
		source: DocumentSource;
		user: Api.User;
	},
) {
	let channelReady = useCallback((
		_sourceKey: DocumentRouteIdentity,
		resolution?: DocumentRouteResolution,
	) => onReady(layerKey, resolution), [layerKey, onReady]);
	let documentReady = useCallback((pathname?: string, channel?: Api.Channel) => {
		if (!pathname || !channel) {
			onReady(layerKey);
			return;
		}
		let canonicalRoute = hostedRoute(pathname);
		if (canonicalRoute.page !== "document" && canonicalRoute.page !== "child") {
			onReady(layerKey);
			return;
		}
		onReady(layerKey, {
			canonicalPath: pathname,
			channel,
			routeKey: documentRouteIdentity(canonicalRoute),
		});
	}, [layerKey, onReady]);
	let metadataPath = useCallback(
		(pathname: string) => onCanonicalPath(layerKey, pathname),
		[layerKey, onCanonicalPath],
	);
	if (source.page === "document" || source.page === "child") {
		return (
			<Suspense fallback={<Loading label="Opening document..." />}>
				<DocumentWorkspaceHost
					agent={agent}
					Failure={Failure}
					Loading={Loading}
					loadDocument={prepareDocumentLoad}
					onCanonicalPath={metadataPath}
					onChildClose={onChildClose}
					onParentRestored={onParentRestored}
					onReady={documentReady}
					retryable={retryableChannelFailure}
					route={source}
					user={user}
				/>
			</Suspense>
		);
	}
	return <ChannelWorkspace agent={agent} onReady={channelReady} source={source} user={user} />;
}

function DocumentRouteSwap(
	{
		agent,
		onCanonicalPath,
		onChildClose,
		onParentRestored,
		route,
		user,
	}: {
		agent: boolean;
		onCanonicalPath: (pathname: string) => void;
		onChildClose: (parentPath: string) => void;
		onParentRestored: (parentId: string) => void;
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
	let presentedRequest = state.pending ?? state.current;
	if (requested.key !== presentedRequest.key) {
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
	let metadataPath = useCallback((key: DocumentRouteIdentity, pathname: string) => {
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
				let source = layer.key === requested.key ? requested.source : layer.source;
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
						<DocumentRouteLayerWorkspace
							agent={agent}
							layerKey={layer.key}
							onCanonicalPath={metadataPath}
							onChildClose={onChildClose}
							onParentRestored={onParentRestored}
							onReady={ready}
							source={source}
							user={user}
						/>
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
	let childOpener = useRef<HTMLElement | undefined>(undefined);
	let navigate = useCallback((destination: string, options: { replace?: boolean } = {}) => {
		let target = new URL(destination, location.href);
		if (target.origin !== location.origin) {
			location.assign(target.href);
			return;
		}
		let next = `${target.pathname}${target.search}${target.hash}`;
		let current = `${location.pathname}${location.search}${location.hash}`;
		if (next === current) return;
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
				childOpener.current = active instanceof HTMLElement ? active : undefined;
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
	}, []);
	let canonicalPath = useCallback((pathname: string) => {
		if (location.pathname === pathname) return;
		history.replaceState(
			history.state,
			"",
			`${pathname}${location.search}${location.hash}`,
		);
		setRoute(hostedRoute(pathname));
	}, []);
	let closeChild = useCallback((parentPath: string) => {
		let action = childCloseAction(history.state, parentPath);
		if (action.type === "back") history.back();
		else navigate(action.destination, { replace: true });
	}, [navigate]);
	let restoreParentFocus = useCallback((parentId: string) => {
		let target = childOpener.current;
		childOpener.current = undefined;
		requestAnimationFrame(() => {
			if (target?.isConnected) target.focus({ preventScroll: true });
			else {
				document.querySelector<HTMLElement>(
					`[data-workspace-room="${CSS.escape(parentId)}"] [data-document-view="plan"] h2`,
				)?.focus({ preventScroll: true });
			}
		});
	}, []);

	useEffect(() => {
		let changed = () => setRoute(hostedRoute(location.pathname));
		window.addEventListener("popstate", changed);
		return () => window.removeEventListener("popstate", changed);
	}, []);

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
					onParentRestored={restoreParentFocus}
					route={route}
					user={user}
				/>
			);
			break;
		case "research":
			workspace = (
				<ActiveChannelWorkspace
					agent={agent}
					key={documentRouteIdentity(route)}
					source={route}
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
