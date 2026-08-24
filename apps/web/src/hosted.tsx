import { useCallback, useEffect, useState } from "react";
import {
	documentPath,
	documentsPath,
	parseDocumentPath,
	parseResearchWorkspacePath,
	researchWorkspacePath,
} from "@chopin/protocol/document-url";

import * as Api from "./api";
import { readChannelRecovery, readDocumentRecovery, rememberChannel } from "./channel-recovery";
import { newestDocument } from "./document-actions";
import { NavigationShell, useNavigationDocument } from "./navigation-shell";

import type { ComponentType, ReactNode } from "react";

export type HostedWorkspaceProps = {
	room: string;
	handle: string;
	label: string;
	slug: string;
	updatedAt: string;
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
	{ agent, id, owner, repository, researchWorkspaceId, slug, user }: {
		agent: boolean;
		id?: string;
		owner?: string;
		repository?: string;
		researchWorkspaceId?: string;
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
				void onDocumentLoaded(value.channel);
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
		onDocumentLoaded,
		owner,
		repository,
		researchWorkspaceId,
		retry,
		slug,
		user.id,
	]);
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
			workspace = (
				<ChannelWorkspace
					agent={agent}
					key={`document:${route.owner}/${route.repository}/${route.slug}`}
					owner={route.owner}
					repository={route.repository}
					slug={route.slug}
					user={user}
				/>
			);
			break;
		case "research":
			workspace = (
				<ChannelWorkspace
					agent={agent}
					key={`research:${route.owner}/${route.repository}/${route.slug}/${route.workspaceId}`}
					owner={route.owner}
					repository={route.repository}
					researchWorkspaceId={route.workspaceId}
					slug={route.slug}
					user={user}
				/>
			);
			break;
		case "channel":
			workspace = (
				<ChannelWorkspace agent={agent} id={route.id} key={`channel:${route.id}`} user={user} />
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
