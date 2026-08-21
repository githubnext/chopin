import { useEffect, useState } from "react";
import { documentPath, documentsPath, parseDocumentPath } from "@chopin/protocol/document-url";

import * as Api from "./api";
import { readChannelRecovery, readDocumentRecovery, rememberChannel } from "./channel-recovery";
import { NavigationShell, useNavigationDocument } from "./navigation-shell";

import type { ComponentType } from "react";

export type HostedWorkspaceProps = {
	room: string;
	handle: string;
	label: string;
	slug: string;
	updatedAt: string;
	repository: Api.Repository;
	canEdit: boolean;
	agent?: boolean;
	userId: string;
};

export type HostedRoute =
	| { page: "repositories" }
	| { page: "repository"; owner: string; repository: string }
	| { page: "document"; owner: string; repository: string; slug: string }
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
	{ agent, id, owner, repository, slug, user }: {
		agent: boolean;
		id?: string;
		owner?: string;
		repository?: string;
		slug?: string;
		user: Api.User;
	},
) {
	let [loaded, setLoaded] = useState<{
		detail: Api.ChannelDetail;
		Workspace: ComponentType<HostedWorkspaceProps>;
	}>();
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
		let detail = id
			? Api.channel(id)
			: Api.document(owner!, repository!, slug!);
		let prepared = detail.then(value => {
			if (active) {
				canonicalize(documentPath(
					value.repository.owner,
					value.repository.name,
					value.channel.slug,
				));
				rememberChannel(user.id, value.channel, value.repository);
				onDocumentLoaded(value.channel);
			}
			return value;
		});
		Promise.all([prepared, import("./room-workspace")]).then(([detail, module]) => {
			if (active) setLoaded({ detail, Workspace: module.RoomWorkspace });
		}, reason => {
			if (active) setError(reason);
		});
		return () => {
			active = false;
		};
	}, [id, onDocumentLoaded, owner, repository, retry, slug, user.id]);
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
	let { detail, Workspace } = loaded;
	let channel = navigationChannel?.id === detail.channel.id
		? navigationChannel
		: detail.channel;
	return (
		<Workspace
			agent={agent}
			canEdit={detail.canEdit}
			handle={user.login}
			label={channel.title}
			slug={channel.slug}
			updatedAt={channel.updatedAt}
			repository={detail.repository}
			room={detail.channel.id}
			userId={user.id}
		/>
	);
}

export function HostedApp(
	{ agent, user }: { agent: boolean; user: Api.User },
) {
	let route = hostedRoute(location.pathname);
	switch (route.page) {
		case "repositories":
		case "repository":
			return <NavigationShell route={route} user={user} />;
		case "document":
			return (
				<NavigationShell route={route} user={user}>
					<ChannelWorkspace
						agent={agent}
						owner={route.owner}
						repository={route.repository}
						slug={route.slug}
						user={user}
					/>
				</NavigationShell>
			);
		case "channel":
			return (
				<NavigationShell route={route} user={user}>
					<ChannelWorkspace agent={agent} id={route.id} user={user} />
				</NavigationShell>
			);
		case "missing":
			return <Failure error={new Error("This page does not exist.")} />;
	}
}

export { Failure as HostedFailure, Loading as HostedLoading };
