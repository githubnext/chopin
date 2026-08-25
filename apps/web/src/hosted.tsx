import { useCallback, useEffect, useReducer, useState } from "react";
import { ContentSwapLayer } from "@chopin/editor/content-swap";
import {
	documentPath,
	documentsPath,
	parseDocumentPath,
	parseResearchWorkspacePath,
	researchWorkspacePath,
} from "@chopin/protocol/document-url";

import * as Api from "./api";
import { readChannelRecovery, readDocumentRecovery, rememberChannel } from "./channel-recovery";
import {
	closeDocumentRoute,
	initialDocumentRouteSwap,
	requestDocumentRoute,
	resolveDocumentRoute,
} from "./document-route-swap";
import { newestDocument } from "./document-actions";
import { motionContract } from "./motion-contract";
import { motionImmediately } from "./motion-input";
import { NavigationShell, useNavigationDocument } from "./navigation-shell";

import type { ComponentType, ReactNode } from "react";
import type { DocumentRouteSwap as DocumentRouteSwapState } from "./document-route-swap";

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
};

export type HostedRoute =
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
	| { page: "channel"; id: string }
	| { page: "missing" };

type DocumentRoute = Extract<HostedRoute, { page: "document" } | { page: "channel" }>;
type KeyedDocumentRoute = { immediately: boolean; key: string; route: DocumentRoute };
type DocumentRouteAction =
	| { route: KeyedDocumentRoute; type: "requested" }
	| { key: string; type: "resolved" | "closed" };

function keyedDocumentRoute(route: DocumentRoute, immediately: boolean): KeyedDocumentRoute {
	return {
		immediately,
		key: route.page === "channel"
			? `channel:${route.id}`
			: `document:${route.owner}/${route.repository}/${route.slug}`,
		route,
	};
}

function transitionDocumentRoute(
	state: DocumentRouteSwapState<KeyedDocumentRoute>,
	action: DocumentRouteAction,
): DocumentRouteSwapState<KeyedDocumentRoute> {
	if (action.type === "requested") return requestDocumentRoute(state, action.route);
	if (action.type === "resolved") return resolveDocumentRoute(state, action.key);
	return closeDocumentRoute(state, action.key);
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

function canonicalize(pathname: string): void {
	if (location.pathname === pathname) return;
	history.replaceState(null, "", `${pathname}${location.search}${location.hash}`);
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
	{
		active = true,
		agent,
		id,
		onResolved,
		owner,
		repository,
		researchWorkspaceId,
		routeKey,
		showLoading = true,
		slug,
		user,
	}: {
		active?: boolean;
		agent: boolean;
		id?: string;
		onResolved?: (key: string) => void;
		owner?: string;
		repository?: string;
		researchWorkspaceId?: string;
		routeKey: string;
		showLoading?: boolean;
		slug?: string;
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
		};
	let [loaded, setLoaded] = useState<LoadedWorkspace>();
	let [error, setError] = useState<unknown>();
	let [retry, setRetry] = useState(0);
	let { channel: navigationChannel, onDocumentLoaded } = useNavigationDocument();
	let recovery = id
		? readChannelRecovery(user.id, id)
		: owner && repository && slug
		? readDocumentRecovery(user.id, owner, repository, slug)
		: undefined;

	useEffect(() => {
		let active = true;
		let controller = new AbortController();
		setLoaded(undefined);
		setError(undefined);
		let detail = id
			? Api.channel(id, controller.signal)
			: Api.document(owner!, repository!, slug!, controller.signal);
		let prepared = detail.then(value => {
			if (active) {
				canonicalize(
					researchWorkspaceId
						? researchWorkspacePath(
							value.repository.owner,
							value.repository.name,
							value.channel.slug,
							researchWorkspaceId,
						)
						: documentPath(
							value.repository.owner,
							value.repository.name,
							value.channel.slug,
						),
				);
				rememberChannel(user.id, value.channel, value.repository);
			}
			return value;
		});
		let workspace = researchWorkspaceId
			? import("./research-workspace").then(module => ({
				kind: "research" as const,
				Workspace: module.ResearchWorkspace,
			}))
			: import("./room-workspace").then(module => ({
				kind: "document" as const,
				Workspace: module.RoomWorkspace,
			}));
		Promise.all([prepared, workspace]).then(([detail, selected]) => {
			if (active) setLoaded({ detail, ...selected } as LoadedWorkspace);
		}, reason => {
			if (active) setError(reason);
		});
		return () => {
			active = false;
			controller.abort();
		};
	}, [
		id,
		owner,
		repository,
		researchWorkspaceId,
		retry,
		routeKey,
		slug,
		user.id,
	]);

	useEffect(() => {
		if (active && loaded) void onDocumentLoaded(loaded.detail.channel, routeKey);
	}, [active, loaded, onDocumentLoaded, routeKey]);

	useEffect(() => {
		if (loaded || error !== undefined) onResolved?.(routeKey);
	}, [error, loaded, onResolved, routeKey]);

	if (error) {
		let requestedRepository = owner && repository
			? { owner, name: repository, fullName: `${owner}/${repository}` }
			: undefined;
		return (
			<Failure
				channel={recovery?.channel ?? (slug ? { slug } : undefined)}
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
	if (!loaded) return showLoading ? <Loading label="Opening channel..." /> : null;
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
		return <Research {...props} workspaceId={researchWorkspaceId!} />;
	}
	let Document = loaded.Workspace;
	return <Document {...props} />;
}

function DocumentRouteSwap(
	{ agent, route, user }: { agent: boolean; route: DocumentRoute; user: Api.User },
) {
	let requested = keyedDocumentRoute(route, motionImmediately());
	let [state, dispatch] = useReducer(
		transitionDocumentRoute,
		initialDocumentRouteSwap(requested),
	);
	let presentedRequest = state.pending ?? state.current;
	if (requested.key !== presentedRequest.key) {
		dispatch({ route: requested, type: "requested" });
	}
	let layers = [state.previous, state.current, state.pending].filter(
		(layer): layer is KeyedDocumentRoute => layer !== undefined,
	);
	let motion = motionContract("content-swap");
	let resolved = useCallback((key: string) => dispatch({ key, type: "resolved" }), []);

	return (
		<div className="document-route-swap content-swap-stack h-full">
			{layers.map(layer => (
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
					<ChannelWorkspace
						active={layer.key === state.current.key}
						agent={agent}
						onResolved={resolved}
						routeKey={layer.key}
						showLoading={layer.key === state.current.key}
						user={user}
						{...(layer.route.page === "channel"
							? { id: layer.route.id }
							: {
								owner: layer.route.owner,
								repository: layer.route.repository,
								slug: layer.route.slug,
							})}
					/>
				</ContentSwapLayer>
			))}
		</div>
	);
}

export function HostedApp(
	{ agent, user }: { agent: boolean; user: Api.User },
) {
	let [route, setRoute] = useState(() => hostedRoute(location.pathname));
	let navigate = useCallback((destination: string, options: { replace?: boolean } = {}) => {
		let target = new URL(destination, location.href);
		if (target.origin !== location.origin) {
			location.assign(target.href);
			return;
		}
		let next = `${target.pathname}${target.search}${target.hash}`;
		let current = `${location.pathname}${location.search}${location.hash}`;
		if (next === current) return;
		if (options.replace) history.replaceState(null, "", next);
		else history.pushState(null, "", next);
		setRoute(hostedRoute(target.pathname));
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
		case "channel":
			workspace = <DocumentRouteSwap agent={agent} route={route} user={user} />;
			break;
		case "research":
			workspace = (
				<ChannelWorkspace
					agent={agent}
					key={`research:${route.owner}/${route.repository}/${route.slug}/${route.workspaceId}`}
					owner={route.owner}
					repository={route.repository}
					researchWorkspaceId={route.workspaceId}
					routeKey={`research:${route.owner}/${route.repository}/${route.slug}/${route.workspaceId}`}
					slug={route.slug}
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
