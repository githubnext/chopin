import { useEffect, useState } from "react";

import * as Api from "./api";

import type { ComponentType, FormEvent, ReactNode } from "react";

export type HostedWorkspaceProps = {
	room: string;
	handle: string;
	label: string;
	canEdit: boolean;
	agent?: boolean;
};

export type HostedRoute =
	| { page: "repositories" }
	| { page: "repository"; owner: string; repository: string }
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

function Frame({ children, user }: { children: ReactNode; user: Api.User }) {
	async function signOut() {
		await Api.logout();
		location.assign("/");
	}

	return (
		<div className="min-h-full bg-ground text-text-primary">
			<header className="hairline-b flex h-14 items-center bg-page px-6">
				<a className="text-sm font-semibold" href="/">chopin</a>
				<div className="ml-auto flex items-center gap-3">
					<span className="text-sm text-text-secondary">{user.login}</span>
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
		<div className="flex h-full items-center justify-center bg-ground text-sm text-text-tertiary">
			{label}
		</div>
	);
}

function Failure({ error }: { error: unknown }) {
	let message = error instanceof Error ? error.message : "Something went wrong";
	return (
		<div className="flex h-full items-center justify-center bg-ground p-6">
			<div className="ring-hairline max-w-md rounded-lg bg-page p-6 shadow-resting">
				<h1 className="text-xl font-semibold">Cannot open Chopin</h1>
				<p className="mt-2 text-sm text-text-secondary">{message}</p>
				<a className="btn btn-md btn-secondary mt-5" href="/">Back to repositories</a>
			</div>
		</div>
	);
}

export function HostedLogin() {
	return (
		<div className="grid h-full bg-ground lg:grid-cols-[1.15fr_0.85fr]">
			<section className="flex items-end bg-text-primary p-10 text-page lg:p-16">
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
			<section className="flex items-center justify-center p-8">
				<div className="w-full max-w-sm">
					<h2 className="text-xl font-semibold">Open your workspace</h2>
					<p className="mt-2 text-sm text-text-secondary">
						Sign in with GitHub to choose a repository and its planning channels.
					</p>
					<a className="btn btn-md btn-primary mt-6 w-full" href="/auth/github">
						Continue with GitHub
					</a>
				</div>
			</section>
		</div>
	);
}

function RepositoryList({ user }: { user: Api.User }) {
	let [page, setPage] = useState<Api.RepositoryPage>();
	let [error, setError] = useState<unknown>();
	let [loadingMore, setLoadingMore] = useState(false);

	useEffect(() => {
		let active = true;
		Api.repositories().then(value => {
			if (active) setPage(value);
		}, reason => {
			if (active) setError(reason);
		});
		return () => {
			active = false;
		};
	}, []);

	async function more() {
		if (!page?.nextPage || loadingMore) return;
		setLoadingMore(true);
		try {
			let next = await Api.repositories(page.nextPage);
			setPage({
				repositories: [...page.repositories, ...next.repositories],
				nextPage: next.nextPage,
			});
		} catch (reason) {
			setError(reason);
		} finally {
			setLoadingMore(false);
		}
	}

	if (error) return <Failure error={error} />;
	return (
		<Frame user={user}>
			<main className="mx-auto w-full max-w-5xl px-6 py-12">
				<p className="text-sm font-medium text-brand-ink">Repositories</p>
				<h1 className="mt-2 text-2xl font-semibold">Where are you planning?</h1>
				<p className="mt-3 text-sm text-text-secondary">
					Choose a repository. Its channels live in Chopin; its code stays in GitHub.
				</p>
				{!page
					? <p className="mt-10 text-sm text-text-tertiary">Loading repositories...</p>
					: (
						<div className="mt-8 grid gap-3 sm:grid-cols-2">
							{page.repositories.map(repository => (
								<a
									className="ring-hairline rounded-lg bg-page p-5 shadow-resting transition-shadow hover:shadow-raised"
									href={`/repositories/${encodeURIComponent(repository.owner)}/${
										encodeURIComponent(repository.name)
									}`}
									key={repository.id}
								>
									<div className="flex items-center gap-2">
										<span className="text-sm font-semibold">{repository.fullName}</span>
										{repository.private && (
											<span className="rounded-sm bg-inset px-1.5 text-sm text-text-tertiary">
												Private
											</span>
										)}
									</div>
									<p className="mt-4 text-sm text-text-tertiary">
										{repository.permissions.push || repository.permissions.admin
											? "Create and edit channels"
											: "View channels"}
									</p>
								</a>
							))}
						</div>
					)}
				{page?.nextPage && (
					<button
						className="btn btn-md btn-secondary mt-6"
						disabled={loadingMore}
						onClick={() => void more()}
						type="button"
					>
						{loadingMore ? "Loading..." : "More repositories"}
					</button>
				)}
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

	useEffect(() => {
		let active = true;
		Api.channels(owner, repository).then(value => {
			if (active) setPage(value);
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
			location.assign(`/channels/${result.channel.id}`);
		} catch (reason) {
			setError(reason);
			setCreating(false);
		}
	}

	async function more() {
		if (!page?.nextCursor || loadingMore) return;
		setLoadingMore(true);
		try {
			let next = await Api.channels(owner, repository, page.nextCursor);
			setPage({ ...next, channels: [...page.channels, ...next.channels] });
		} catch (reason) {
			setError(reason);
		} finally {
			setLoadingMore(false);
		}
	}

	if (error) return <Failure error={error} />;
	return (
		<Frame user={user}>
			<main className="mx-auto w-full max-w-4xl px-6 py-12">
				<a className="text-sm text-brand-ink" href="/">Repositories</a>
				<h1 className="mt-3 text-2xl font-semibold">{owner}/{repository}</h1>
				<div className="mt-8 flex items-end justify-between gap-6">
					<div>
						<h2 className="text-xl font-semibold">Planning channels</h2>
						<p className="mt-1 text-sm text-text-secondary">
							One shared plan and conversation per channel.
						</p>
					</div>
				</div>
				{page?.canEdit && (
					<form className="ring-hairline mt-6 flex gap-2 rounded-lg bg-page p-3" onSubmit={create}>
						<label className="sr-only" htmlFor="channel-title">Channel title</label>
						<input
							className="field min-w-0 flex-1 px-3 text-sm"
							id="channel-title"
							maxLength={120}
							onChange={event =>
								setTitle(event.target.value)}
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
						<div className="ring-hairline mt-6 rounded-lg bg-page p-8 text-center">
							<p className="text-sm font-medium">No planning channels yet</p>
							<p className="mt-1 text-sm text-text-tertiary">
								{page.canEdit
									? "Create the first one above."
									: "A repository editor can create one."}
							</p>
						</div>
					)
					: (
						<div className="ring-hairline mt-6 overflow-hidden rounded-lg bg-page">
							{page.channels.map((channel, index) => (
								<a
									className={`flex items-center justify-between gap-4 px-5 py-4 hover:bg-hover ${
										index ? "hairline-t" : ""
									}`}
									href={`/channels/${channel.id}`}
									key={channel.id}
								>
									<span className="text-sm font-medium">{channel.title}</span>
									<span className="text-sm text-text-tertiary">
										{new Date(channel.updatedAt).toLocaleDateString()}
									</span>
								</a>
							))}
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
	{ id, user, Workspace }: {
		id: string;
		user: Api.User;
		Workspace: ComponentType<HostedWorkspaceProps>;
	},
) {
	let [detail, setDetail] = useState<Api.ChannelDetail>();
	let [error, setError] = useState<unknown>();

	useEffect(() => {
		let active = true;
		Api.channel(id).then(value => {
			if (active) setDetail(value);
		}, reason => {
			if (active) setError(reason);
		});
		return () => {
			active = false;
		};
	}, [id]);

	if (error) return <Failure error={error} />;
	if (!detail) return <Loading label="Opening channel..." />;
	return (
		<Workspace
			agent={false}
			canEdit={detail.canEdit}
			handle={user.login}
			label={`${detail.repository.fullName} / ${detail.channel.title}`}
			room={detail.channel.id}
		/>
	);
}

export function HostedApp(
	{ user, Workspace }: { user: Api.User; Workspace: ComponentType<HostedWorkspaceProps> },
) {
	let route = hostedRoute(location.pathname);
	switch (route.page) {
		case "repositories":
			return <RepositoryList user={user} />;
		case "repository":
			return <RepositoryChannels owner={route.owner} repository={route.repository} user={user} />;
		case "channel":
			return <ChannelWorkspace Workspace={Workspace} id={route.id} user={user} />;
		case "missing":
			return <Failure error={new Error("This page does not exist.")} />;
	}
}

export { Failure as HostedFailure, Loading as HostedLoading };
