import { CaretDownIcon, CheckIcon } from "@phosphor-icons/react";
import { createPortal } from "react-dom";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import { useAnchoredPicker } from "./anchored-picker";
import * as Api from "./api";
import {
	clearRepositoryCache,
	installedRepositoryGroups,
	loadRepositorySnapshot,
	readRepositoryCache,
	repositoryCacheIsStale,
	writeRepositoryCache,
} from "./repository-cache";

import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { InstalledRepositoryGroup, RepositorySnapshot } from "./repository-cache";

export type RepositoryIdentity = Pick<
	Api.Repository,
	"owner" | "ownerAvatarUrl" | "name" | "fullName"
>;

function repositoryHref(repository: RepositoryIdentity): string {
	return `/repositories/${encodeURIComponent(repository.owner)}/${
		encodeURIComponent(repository.name)
	}`;
}

function sameRepository(left: RepositoryIdentity | undefined, right: RepositoryIdentity): boolean {
	return left?.owner.toLowerCase() === right.owner.toLowerCase()
		&& left.name.toLowerCase() === right.name.toLowerCase();
}

function optionId(list: string, repository: Api.Repository): string {
	return `${list}-option-${repository.id}`;
}

function reauthenticate(reason: unknown, userId: string): boolean {
	if (!(reason instanceof Api.ApiError) || reason.status !== 401) return false;
	clearRepositoryCache(userId);
	location.assign("/");
	return true;
}

export function RepositoryPicker(
	{
		compact = false,
		current,
		initialOpen = false,
		userId,
	}: { compact?: boolean; current?: RepositoryIdentity; initialOpen?: boolean; userId: string },
) {
	let [initial] = useState(() => readRepositoryCache(userId));
	let request = useRef<Promise<void> | undefined>(undefined);
	let snapshot = useRef<RepositorySnapshot | undefined>(initial);
	let mounted = useRef(true);
	let previousQuery = useRef("");
	let panelId = useId();
	let listId = useId();
	let [open, setOpen] = useState(initialOpen);
	let [installed, setInstalled] = useState<InstalledRepositoryGroup[] | undefined>(() =>
		initial ? installedRepositoryGroups(initial) : undefined
	);
	let [error, setError] = useState<unknown>();
	let [loading, setLoading] = useState(!initial);
	let [refreshing, setRefreshing] = useState(false);
	let [query, setQuery] = useState("");
	let [active, setActive] = useState(0);
	let [avatarFailed, setAvatarFailed] = useState(false);

	let normalized = query.trim().toLowerCase();
	let repositories = installed?.flatMap(group => group.repositories) ?? [];
	let matches = normalized
		? repositories.filter(repository => repository.fullName.toLowerCase().includes(normalized))
		: repositories;
	let activeIndex = matches.length === 0 ? -1 : Math.min(active, matches.length - 1);
	let activeRepository = matches[activeIndex];
	let pickerContent = useMemo(
		() => ({ error, installed, loading, matches: matches.length, normalized, refreshing }),
		[error, installed, loading, matches.length, normalized, refreshing],
	);
	let { panel, position, search, trigger } = useAnchoredPicker(open, setOpen, pickerContent);

	useEffect(() => {
		mounted.current = true;
		if (!snapshot.current) void refresh();
		return () => {
			mounted.current = false;
		};
	}, []);

	useEffect(() => setAvatarFailed(false), [current?.ownerAvatarUrl]);

	useEffect(() => {
		if (!open) {
			previousQuery.current = "";
			return;
		}
		let started = !previousQuery.current && !!normalized;
		previousQuery.current = normalized;
		if (started && snapshot.current && repositoryCacheIsStale(snapshot.current)) void refresh();
	}, [normalized, open]);

	useEffect(() => {
		if (!open || !activeRepository) return;
		let frame = requestAnimationFrame(() => {
			let option = document.getElementById(optionId(listId, activeRepository));
			option?.scrollIntoView({ block: "nearest" });
			let scroller = option?.closest<HTMLElement>("[data-repository-scroll]");
			if (!option || !scroller) return;
			let optionBox = option.getBoundingClientRect();
			let scrollerBox = scroller.getBoundingClientRect();
			if (optionBox.top < scrollerBox.top || optionBox.bottom > scrollerBox.bottom) {
				// Chromium can treat a fractional edge as nearest-visible.
				option.scrollIntoView({ block: "end" });
			}
		});
		return () => cancelAnimationFrame(frame);
	}, [activeRepository, listId, open, position.height, position.top]);

	function refresh(): Promise<void> {
		if (request.current) return request.current;
		let previous = snapshot.current;
		setError(undefined);
		if (previous) setRefreshing(true);
		else setLoading(true);
		let pending = loadRepositorySnapshot(
			userId,
			previous,
			previous
				? undefined
				: value => {
					if (mounted.current) setInstalled(installedRepositoryGroups(value));
				},
		).then(value => {
			if (!mounted.current) return;
			snapshot.current = value;
			writeRepositoryCache(value);
			setInstalled(installedRepositoryGroups(value));
		}, reason => {
			if (mounted.current && !reauthenticate(reason, userId)) setError(reason);
		}).finally(() => {
			if (request.current === pending) request.current = undefined;
			if (mounted.current) {
				setLoading(false);
				setRefreshing(false);
			}
		});
		request.current = pending;
		return pending;
	}

	function retry() {
		void refresh();
	}

	function select(repository: Api.Repository) {
		location.assign(repositoryHref(repository));
	}

	function searchKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
		if (event.key === "ArrowDown") {
			setActive(value => matches.length === 0 ? 0 : (value + 1) % matches.length);
		} else if (event.key === "ArrowUp") {
			setActive(value => matches.length === 0 ? 0 : (value - 1 + matches.length) % matches.length);
		} else if (event.key === "Enter" && activeRepository) {
			select(activeRepository);
		} else {
			return;
		}
		event.preventDefault();
	}

	let popup = open && createPortal(
		<div
			className="fixed z-50 flex flex-col rounded-lg bg-page ring-hairline shadow-overlay"
			id={panelId}
			ref={panel}
			style={position}
		>
			<div className="p-2 hairline-b">
				<label className="sr-only" htmlFor={`${listId}-search`}>Search repositories</label>
				<input
					aria-activedescendant={activeRepository ? optionId(listId, activeRepository) : undefined}
					aria-autocomplete="list"
					aria-controls={listId}
					aria-expanded="true"
					className="repository-picker-search field h-8 w-full px-2 text-sm"
					id={`${listId}-search`}
					onChange={event => {
						setQuery(event.target.value);
						setActive(0);
					}}
					onKeyDown={searchKeyDown}
					placeholder="Find a repository"
					ref={search}
					role="combobox"
					value={query}
				/>
			</div>
			<div
				className="min-h-0 flex-1 overflow-y-auto p-1"
				data-focus-boundary=""
				data-repository-scroll=""
			>
				{!installed && loading && (
					<p className="px-2 py-3 text-sm text-text-tertiary" role="status">
						Loading repositories...
					</p>
				)}
				{!installed && !loading && error !== undefined && (
					<div className="px-2 py-3">
						<p className="text-sm text-destructive-ink" role="alert">
							Could not load repositories.
						</p>
						<button className="btn btn-sm btn-secondary mt-2" onClick={retry} type="button">
							Try again
						</button>
					</div>
				)}
				{installed?.length === 0 && !loading && (
					<div className="px-2 py-3">
						<p className="text-sm font-medium">Install the GitHub App</p>
						<p className="mt-1 text-sm text-text-tertiary">
							Choose the personal or organization repositories Chopin may read.
						</p>
						<a className="btn btn-sm btn-primary mt-3" href="/auth/github/install">
							Install GitHub App
						</a>
					</div>
				)}
				{installed && loading && repositories.length === 0 && installed.length > 0 && (
					<p className="px-2 py-3 text-sm text-text-tertiary" role="status">
						Loading installed repositories...
					</p>
				)}
				{installed && loading && repositories.length > 0 && (
					<p className="px-2 py-2 text-sm text-text-tertiary" role="status">
						Loading remaining repositories...
					</p>
				)}
				{installed && refreshing && (
					<p className="px-2 py-2 text-sm text-text-tertiary" role="status">
						Refreshing repositories...
					</p>
				)}
				{installed
					&& repositories.length === 0
					&& installed.length > 0
					&& !loading
					&& (
						<p className="px-2 py-3 text-sm text-text-tertiary" role="status">
							No installed repositories are available.
						</p>
					)}
				{installed && repositories.length > 0 && matches.length === 0 && (
					<p className="px-2 py-3 text-sm text-text-tertiary" role="status">
						{loading || refreshing
							? "Checking for matching repositories..."
							: "No matching repositories."}
					</p>
				)}
				{installed?.filter(group =>
					group.installation.suspended || !group.installation.permissions.contents
				).map(group => (
					<div className="flex items-center gap-2 px-2 py-2 text-sm" key={group.installation.id}>
						<span className="min-w-0 flex-1 truncate text-text-tertiary">
							{group.installation.account.login}
						</span>
						<a
							className="text-brand-ink hover:underline"
							href={group.installation.configureUrl}
						>
							Configure
						</a>
					</div>
				))}
				<div
					aria-busy={loading || refreshing}
					aria-label="Repositories"
					id={listId}
					role="listbox"
				>
					{installed?.map(group => {
						let known = new Set(group.repositories.map(repository => repository.id));
						let groupRepositories = matches.filter(repository => known.has(repository.id));
						if (groupRepositories.length === 0) return null;
						return (
							<div
								aria-label={`${group.installation.account.login} repositories`}
								className="mb-1 last:mb-0"
								key={group.installation.id}
								role="group"
							>
								<div
									className="flex items-center gap-2 px-2 py-1.5 text-sm text-text-tertiary"
									role="presentation"
								>
									<span className="min-w-0 flex-1 truncate">
										{group.installation.account.login}
									</span>
								</div>
								{groupRepositories.map(repository => {
									let index = matches.findIndex(value => value.id === repository.id);
									let selected = sameRepository(current, repository);
									return (
										<button
											aria-selected={selected}
											className={`flex w-full items-center gap-2 rounded-sm px-2 py-2 text-left transition ${
												index === activeIndex ? "bg-selected" : "hover:bg-hover"
											}`}
											id={optionId(listId, repository)}
											key={repository.id}
											onClick={() => select(repository)}
											onMouseEnter={() => setActive(index)}
											role="option"
											tabIndex={-1}
											type="button"
										>
											<span className="min-w-0 flex-1">
												<span className="flex items-center gap-2">
													<span className="truncate text-sm font-medium">
														{repository.fullName}
													</span>
													{repository.private && (
														<span className="shrink-0 rounded-sm bg-inset px-1.5 text-sm text-text-tertiary">
															Private
														</span>
													)}
												</span>
												<span className="block text-sm text-text-tertiary">
													{repository.permissions.push || repository.permissions.admin
														? "Create and edit channels"
														: "View channels"}
												</span>
											</span>
											{selected && (
												<CheckIcon
													aria-hidden="true"
													className="shrink-0 text-brand-ink"
													size={16}
												/>
											)}
										</button>
									);
								})}
							</div>
						);
					})}
				</div>
			</div>
			{installed && (
				<div className="p-1 hairline-t">
					{error !== undefined && (
						<div className="flex items-center gap-2 px-2 py-1 text-sm" role="alert">
							<span className="min-w-0 flex-1 text-destructive-ink">
								{snapshot.current
									? "Could not refresh repositories."
									: "Could not load all repositories."}
							</span>
							<button className="text-brand-ink hover:underline" onClick={retry} type="button">
								Try again
							</button>
						</div>
					)}
					<a className="btn btn-md btn-ghost w-full" href="/auth/github/install">
						Manage repository access
					</a>
				</div>
			)}
		</div>,
		document.body,
	);

	return (
		<>
			<button
				aria-label={current ? `Repository: ${current.fullName}` : "Choose repository"}
				aria-controls={panelId}
				aria-expanded={open}
				aria-haspopup="listbox"
				className={`repository-picker-trigger btn btn-sm btn-ghost min-w-0 gap-1.5 ${
					compact ? "max-w-32 sm:max-w-40" : "max-w-40 sm:max-w-64"
				}`}
				onClick={() => setOpen(value => !value)}
				ref={trigger}
				title={current?.fullName}
				type="button"
			>
				{compact && current && (
					<span
						aria-hidden="true"
						className="size-5 shrink-0 overflow-hidden rounded-full bg-inset"
					>
						{current.ownerAvatarUrl && !avatarFailed
							? (
								<img
									alt=""
									className="size-full object-cover"
									onError={() => setAvatarFailed(true)}
									src={current.ownerAvatarUrl}
								/>
							)
							: (
								<span className="flex size-full items-center justify-center text-[10px] font-medium">
									{current.owner.slice(0, 1).toUpperCase()}
								</span>
							)}
					</span>
				)}
				<span className="truncate">
					{compact
						? current?.name ?? "Choose repository"
						: current?.fullName ?? "Choose repository"}
				</span>
				<CaretDownIcon aria-hidden="true" className="shrink-0" size={14} />
			</button>
			{popup}
		</>
	);
}
