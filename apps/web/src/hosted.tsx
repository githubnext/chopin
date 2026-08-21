import { useEffect, useState } from "react";
import { documentPath, documentsPath, parseDocumentPath } from "@chopin/protocol/document-url";

import * as Api from "./api";
import { readChannelRecovery, readDocumentRecovery, rememberChannel } from "./channel-recovery";
import { DocumentRename } from "./document-rename";
import { RepositoryPicker } from "./repository-picker";
import { clearRepositoryCache } from "./repository-cache";

import type { ComponentType, FormEvent, ReactNode } from "react";

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

function Frame(
	{
		children,
		currentRepository,
		openRepositoryPicker = false,
		user,
	}: {
		children: ReactNode;
		currentRepository?: Api.Repository | { owner: string; name: string; fullName: string };
		openRepositoryPicker?: boolean;
		user: Api.User;
	},
) {
	async function signOut() {
		await Api.logout();
		clearRepositoryCache(user.id);
		location.assign("/");
	}

	return (
		<div className="min-h-full bg-ground text-text-primary" data-hosted="">
			<header className="hosted-header hairline-b flex h-14 items-center bg-page px-3 sm:px-6">
				<a className="text-sm font-semibold" href="/">chopin</a>
				<span aria-hidden="true" className="mx-1 h-4 hairline-l sm:mx-2" />
				<RepositoryPicker
					current={currentRepository}
					initialOpen={openRepositoryPicker}
					key={user.id}
					userId={user.id}
				/>
				<div className="ml-auto flex items-center gap-3">
					<span className="hidden text-sm text-text-secondary sm:inline">{user.login}</span>
					<button className="btn btn-sm btn-ghost" onClick={() => void signOut()} type="button">
						Sign out
					</button>
				</div>
			</header>
			{children}
		</div>
	);
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

function RepositoryHome({ user }: { user: Api.User }) {
	return (
		<Frame openRepositoryPicker user={user}>
			<main className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6 sm:py-12">
				<p className="text-sm text-text-tertiary">
					Choose a repository from the menu to see its planning channels.
				</p>
			</main>
		</Frame>
	);
}

function RepositoryChannels(
	{ owner, repository, user }: { owner: string; repository: string; user: Api.User },
) {
	let [page, setPage] = useState<Api.ChannelPage>();
	let [error, setError] = useState<unknown>();
	let [title, setTitle] = useState("");
	let [creating, setCreating] = useState(false);
	let [loadingMore, setLoadingMore] = useState(false);
	let [renaming, setRenaming] = useState<string>();

	useEffect(() => {
		canonicalize(documentsPath(owner, repository));
	}, [owner, repository]);

	useEffect(() => {
		let active = true;
		Api.channels(owner, repository).then(value => {
			if (active) {
				canonicalize(documentsPath(value.repository.owner, value.repository.name));
				setPage(value);
			}
		}, reason => {
			if (active) setError(reason);
		});
		return () => {
			active = false;
		};
	}, [owner, repository]);

	async function create(event: FormEvent) {
		event.preventDefault();
		if (!title.trim() || creating) return;
		setCreating(true);
		try {
			let result = await Api.createChannel(owner, repository, title.trim());
			rememberChannel(user.id, result.channel, result.repository);
			location.assign(documentPath(
				result.repository.owner,
				result.repository.name,
				result.channel.slug,
			));
		} catch (reason) {
			setError(reason);
			setCreating(false);
		}
	}

	async function more() {
		let cursor = page?.nextCursor;
		if (!cursor || loadingMore) return;
		setLoadingMore(true);
		try {
			let next = await Api.channels(owner, repository, cursor);
			setPage(current =>
				current && {
					...next,
					channels: [
						...current.channels,
						...next.channels.filter(channel =>
							!current.channels.some(known => known.id === channel.id)
						),
					],
				}
			);
		} catch (reason) {
			setError(reason);
		} finally {
			setLoadingMore(false);
		}
	}

	function stopRenaming(id: string) {
		setRenaming(undefined);
		requestAnimationFrame(() => document.getElementById(`rename-channel-${id}`)?.focus());
	}

	function renamed(detail: Api.ChannelDetail) {
		rememberChannel(user.id, detail.channel, detail.repository);
		setPage(current => {
			if (!current) return current;
			let channels = current.channels
				.map(channel => channel.id === detail.channel.id ? detail.channel : channel)
				.sort((left, right) =>
					new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
					|| left.id.localeCompare(right.id)
				);
			return { ...current, channels };
		});
		stopRenaming(detail.channel.id);
	}

	if (error) return <Failure error={error} />;
	return (
		<Frame
			currentRepository={page?.repository ?? {
				owner,
				name: repository,
				fullName: `${owner}/${repository}`,
			}}
			user={user}
		>
			<main className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6 sm:py-12">
				<div className="flex items-end justify-between gap-6">
					<div>
						<h1 className="text-2xl font-semibold">Planning channels</h1>
						<p className="mt-1 text-sm text-text-secondary">
							One shared plan and conversation per channel.
						</p>
					</div>
				</div>
				{page?.canEdit && (
					<form
						className="ring-hairline mt-6 flex flex-col gap-2 rounded-lg bg-page p-3 sm:flex-row"
						onSubmit={create}
					>
						<label className="sr-only" htmlFor="channel-title">Channel title</label>
						<input
							className="channel-create-input field min-w-0 flex-1 px-3 text-sm"
							id="channel-title"
							maxLength={120}
							onChange={event => setTitle(event.target.value)}
							placeholder="Plan the next release"
							value={title}
						/>
						<button
							className="btn btn-md btn-primary"
							disabled={!title.trim() || creating}
							type="submit"
						>
							{creating ? "Creating..." : "New channel"}
						</button>
					</form>
				)}
				{!page
					? <p className="mt-8 text-sm text-text-tertiary">Loading channels...</p>
					: page.channels.length === 0
					? (
						<div className="ring-hairline mt-6 rounded-lg bg-page p-4 text-center sm:p-8">
							<p className="text-sm font-medium">No planning channels yet</p>
							<p className="mt-1 text-sm text-text-tertiary">
								{page.canEdit
									? "Create the first one above."
									: "A repository editor can create one."}
							</p>
						</div>
					)
					: (
						<div className="ring-hairline mt-6 rounded-lg bg-page">
							{page.channels.map((channel, index) => {
								let corners = `${index === 0 ? "rounded-t-lg" : ""} ${
									index === page.channels.length - 1 ? "rounded-b-lg" : ""
								}`;
								return (
									<div className={`${index ? "hairline-t" : ""} ${corners}`} key={channel.id}>
										{renaming === channel.id
											? (
												<DocumentRename
													channel={channel}
													className={`${corners} px-4 py-4 sm:px-5`}
													onCancel={() => stopRenaming(channel.id)}
													onRenamed={renamed}
												/>
											)
											: (
												<div
													className={`${corners} flex min-w-0 items-center gap-2 pr-3 hover:bg-hover sm:pr-4`}
												>
													<a
														className="flex min-w-0 flex-1 flex-col items-start justify-between gap-1 px-4 py-4 sm:flex-row sm:items-center sm:gap-4 sm:px-5"
														href={documentPath(
															page.repository.owner,
															page.repository.name,
															channel.slug,
														)}
														onClick={() => rememberChannel(user.id, channel, page.repository)}
													>
														<span className="min-w-0 break-words text-sm font-medium">
															{channel.title}
														</span>
														<span className="text-sm text-text-tertiary sm:shrink-0">
															{new Date(channel.updatedAt).toLocaleDateString()}
														</span>
													</a>
													{page.canEdit && (
														<button
															aria-label={`Rename ${channel.title}`}
															className="btn btn-sm btn-ghost shrink-0"
															disabled={renaming !== undefined}
															id={`rename-channel-${channel.id}`}
															onClick={() => setRenaming(channel.id)}
															type="button"
														>
															Rename
														</button>
													)}
												</div>
											)}
									</div>
								);
							})}
						</div>
					)}
				{page?.nextCursor && (
					<button
						className="btn btn-md btn-secondary mt-6"
						disabled={loadingMore}
						onClick={() => void more()}
						type="button"
					>
						{loadingMore ? "Loading..." : "More channels"}
					</button>
				)}
			</main>
		</Frame>
	);
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
	}, [id, owner, repository, retry, slug, user.id]);
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
	return (
		<Workspace
			agent={agent}
			canEdit={detail.canEdit}
			handle={user.login}
			label={detail.channel.title}
			slug={detail.channel.slug}
			updatedAt={detail.channel.updatedAt}
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
			return <RepositoryHome user={user} />;
		case "repository":
			return <RepositoryChannels owner={route.owner} repository={route.repository} user={user} />;
		case "document":
			return (
				<ChannelWorkspace
					agent={agent}
					owner={route.owner}
					repository={route.repository}
					slug={route.slug}
					user={user}
				/>
			);
		case "channel":
			return <ChannelWorkspace agent={agent} id={route.id} user={user} />;
		case "missing":
			return <Failure error={new Error("This page does not exist.")} />;
	}
}

export { Failure as HostedFailure, Loading as HostedLoading };
