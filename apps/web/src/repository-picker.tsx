import { CaretDownIcon, CheckIcon } from "@phosphor-icons/react";
import { createPortal } from "react-dom";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";

import * as Api from "./api";

import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from "react";

export type RepositoryIdentity = Pick<Api.Repository, "owner" | "name" | "fullName">;

type Position = Pick<CSSProperties, "left" | "maxHeight" | "top" | "visibility" | "width">;

type InstalledRepositories = {
	installation: Api.GitHubInstallation;
	page: Api.RepositoryPage;
	error?: boolean;
	loadingMore?: boolean;
};

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

function reauthenticate(reason: unknown): boolean {
	if (!(reason instanceof Api.ApiError) || reason.status !== 401) return false;
	location.assign("/");
	return true;
}

async function installedRepositories(
	publish: (installed: InstalledRepositories[], replace: boolean) => void,
): Promise<InstalledRepositories[]> {
	let installations: Api.GitHubInstallation[] = [];
	let page = 1;
	let visited = new Set<number>();
	while (!visited.has(page)) {
		visited.add(page);
		let result = await Api.installations(page);
		installations.push(...result.installations);
		if (!result.nextPage) break;
		page = result.nextPage;
	}
	let installed: InstalledRepositories[] = installations.map(installation => ({
		installation,
		page: { repositories: [] },
		loadingMore: !installation.suspended && installation.permissions.contents,
	}));
	publish(installed, true);
	for (let index = 0; index < installed.length; index++) {
		let group = installed[index]!;
		if (!group.loadingMore) continue;
		try {
			let page = await Api.installationRepositories(group.installation.id);
			installed = installed.map((value, position) =>
				position === index ? { installation: group.installation, page, loadingMore: false } : value
			);
		} catch (reason) {
			if (reauthenticate(reason)) throw reason;
			installed = installed.map((value, position) =>
				position === index ? { ...group, error: true, loadingMore: false } : value
			);
		}
		publish([installed[index]!], false);
	}
	return installed;
}

export function RepositoryPicker(
	{ current, initialOpen = false }: { current?: RepositoryIdentity; initialOpen?: boolean },
) {
	let trigger = useRef<HTMLButtonElement>(null);
	let panel = useRef<HTMLDivElement>(null);
	let search = useRef<HTMLInputElement>(null);
	let request = useRef<Promise<InstalledRepositories[]> | undefined>(undefined);
	let mounted = useRef(true);
	let panelId = useId();
	let listId = useId();
	let [open, setOpen] = useState(initialOpen);
	let [position, setPosition] = useState<Position>({ visibility: "hidden" });
	let [installed, setInstalled] = useState<InstalledRepositories[]>();
	let [error, setError] = useState<unknown>();
	let [attempt, setAttempt] = useState(0);
	let [query, setQuery] = useState("");
	let [active, setActive] = useState(0);

	let normalized = query.trim().toLowerCase();
	let repositories = installed?.flatMap(group => group.page.repositories) ?? [];
	let matches = normalized
		? repositories.filter(repository => repository.fullName.toLowerCase().includes(normalized))
		: repositories;
	let activeIndex = matches.length === 0 ? -1 : Math.min(active, matches.length - 1);
	let activeRepository = matches[activeIndex];

	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);

	useEffect(() => {
		if (!open) return;
		let active = true;
		let pending = request.current;
		if (!pending) {
			let created = installedRepositories((value, replace) => {
				if (!mounted.current) return;
				if (replace) return setInstalled(value);
				let replacements = new Map(value.map(group => [group.installation.id, group]));
				setInstalled(current =>
					current?.map(group => replacements.get(group.installation.id) ?? group) ?? value
				);
			});
			request.current = created;
			pending = created;
		}
		pending.then(() => {}, reason => {
			if (active && !reauthenticate(reason)) setError(reason);
		});
		return () => {
			active = false;
		};
	}, [attempt, open]);

	useLayoutEffect(() => {
		if (!open) return;
		function place() {
			let rect = trigger.current?.getBoundingClientRect();
			if (!rect) return;
			let margin = 8;
			let gap = 4;
			let width = Math.max(0, Math.min(360, window.innerWidth - margin * 2));
			let left = Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin));
			let top = rect.bottom + gap;
			setPosition({
				left,
				maxHeight: Math.max(0, window.innerHeight - top - margin),
				top,
				visibility: "visible",
				width,
			});
		}

		place();
		window.addEventListener("resize", place);
		document.addEventListener("scroll", place, true);
		return () => {
			window.removeEventListener("resize", place);
			document.removeEventListener("scroll", place, true);
		};
	}, [open]);

	useEffect(() => {
		if (!open) return;
		let frame = requestAnimationFrame(() => {
			if (!panel.current?.contains(document.activeElement)) search.current?.focus();
		});
		return () => cancelAnimationFrame(frame);
	}, [installed, open]);

	useEffect(() => {
		if (!open || !activeRepository) return;
		document.getElementById(optionId(listId, activeRepository))?.scrollIntoView({
			block: "nearest",
		});
	}, [activeRepository, listId, open]);

	useEffect(() => {
		if (!open) return;
		function closeOnPointer(event: PointerEvent) {
			let target = event.target;
			if (!(target instanceof Node)) return;
			if (trigger.current?.contains(target) || panel.current?.contains(target)) return;
			setOpen(false);
		}

		function closeOnFocus(event: FocusEvent) {
			let target = event.target;
			if (!(target instanceof Node)) return;
			if (trigger.current?.contains(target) || panel.current?.contains(target)) return;
			setOpen(false);
		}

		function closeOnEscape(event: KeyboardEvent) {
			if (event.key !== "Escape") return;
			event.preventDefault();
			setOpen(false);
			trigger.current?.focus();
		}

		document.addEventListener("pointerdown", closeOnPointer);
		document.addEventListener("focusin", closeOnFocus);
		document.addEventListener("keydown", closeOnEscape);
		return () => {
			document.removeEventListener("pointerdown", closeOnPointer);
			document.removeEventListener("focusin", closeOnFocus);
			document.removeEventListener("keydown", closeOnEscape);
		};
	}, [open]);

	function retry() {
		request.current = undefined;
		setError(undefined);
		setInstalled(undefined);
		setAttempt(value => value + 1);
	}

	async function more(installationId: string) {
		let group = installed?.find(value => value.installation.id === installationId);
		if (!group?.page.nextPage || group.loadingMore) return;
		setInstalled(current =>
			current?.map(value =>
				value.installation.id === installationId ? { ...value, loadingMore: true } : value
			)
		);
		setError(undefined);
		try {
			let next = await Api.installationRepositories(installationId, group.page.nextPage);
			if (!mounted.current) return;
			setInstalled(current =>
				current?.map(value => {
					if (value.installation.id !== installationId) return value;
					let known = new Set(value.page.repositories.map(repository => repository.id));
					return {
						...value,
						loadingMore: false,
						page: {
							repositories: [
								...value.page.repositories,
								...next.repositories.filter(repository => !known.has(repository.id)),
							],
							nextPage: next.nextPage,
						},
					};
				})
			);
		} catch (reason) {
			if (mounted.current && !reauthenticate(reason)) setError(reason);
		} finally {
			if (mounted.current) {
				setInstalled(current =>
					current?.map(value =>
						value.installation.id === installationId
							? { ...value, loadingMore: false }
							: value
					)
				);
			}
		}
	}

	async function retryInstallation(installationId: string) {
		setInstalled(current =>
			current?.map(value =>
				value.installation.id === installationId
					? { ...value, error: false, loadingMore: true }
					: value
			)
		);
		try {
			let page = await Api.installationRepositories(installationId);
			if (!mounted.current) return;
			setInstalled(current =>
				current?.map(value =>
					value.installation.id === installationId
						? { ...value, error: false, loadingMore: false, page }
						: value
				)
			);
		} catch (reason) {
			if (mounted.current && !reauthenticate(reason)) {
				setInstalled(current =>
					current?.map(value =>
						value.installation.id === installationId
							? { ...value, error: true, loadingMore: false }
							: value
					)
				);
			}
		}
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
			className="fixed z-50 flex flex-col overflow-hidden rounded-lg bg-page ring-hairline shadow-overlay"
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
					className="field h-8 w-full px-2 text-sm"
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
			<div className="min-h-0 flex-1 overflow-y-auto p-1" data-repository-scroll="">
				{!installed && !error && (
					<p className="px-2 py-3 text-sm text-text-tertiary" role="status">
						Loading repositories...
					</p>
				)}
				{!installed && error !== undefined && (
					<div className="px-2 py-3">
						<p className="text-sm text-destructive-ink" role="alert">
							Could not load repositories.
						</p>
						<button className="btn btn-sm btn-secondary mt-2" onClick={retry} type="button">
							Try again
						</button>
					</div>
				)}
				{installed?.length === 0 && (
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
				{installed?.some(group => group.loadingMore) && repositories.length === 0 && (
					<p className="px-2 py-3 text-sm text-text-tertiary" role="status">
						Loading installed repositories...
					</p>
				)}
				{installed
					&& repositories.length === 0
					&& installed.length > 0
					&& !installed.some(group => group.loadingMore)
					&& (
						<p className="px-2 py-3 text-sm text-text-tertiary" role="status">
							No installed repositories are available.
						</p>
					)}
				{installed && repositories.length > 0 && matches.length === 0 && (
					<p className="px-2 py-3 text-sm text-text-tertiary" role="status">
						{installed.some(group =>
								group.page.nextPage
							)
							? "No matches in loaded repositories."
							: "No matching repositories."}
					</p>
				)}
				{installed?.filter(group =>
					group.error || group.installation.suspended || !group.installation.permissions.contents
				).map(group => (
					<div className="flex items-center gap-2 px-2 py-2 text-sm" key={group.installation.id}>
						<span className="min-w-0 flex-1 truncate text-text-tertiary">
							{group.installation.account.login}
						</span>
						{group.error
							? (
								<button
									className="text-brand-ink hover:underline"
									disabled={group.loadingMore}
									onClick={() => void retryInstallation(group.installation.id)}
									type="button"
								>
									{group.loadingMore ? "Retrying..." : "Try again"}
								</button>
							)
							: (
								<a
									className="text-brand-ink hover:underline"
									href={group.installation.configureUrl}
								>
									Configure
								</a>
							)}
					</div>
				))}
				<div
					aria-busy={(!installed && error === undefined)
						|| installed?.some(group => group.loadingMore)}
					aria-label="Repositories"
					id={listId}
					role="listbox"
				>
					{installed?.map(group => {
						let groupRepositories = matches.filter(repository =>
							repository.owner.toLowerCase() === group.installation.account.login.toLowerCase()
						);
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
						<p className="px-2 py-1 text-sm text-destructive-ink" role="alert">
							Could not load more repositories.
						</p>
					)}
					{installed.filter(group => group.page.nextPage).map(group => (
						<button
							className="btn btn-md btn-ghost w-full"
							disabled={group.loadingMore}
							key={group.installation.id}
							onClick={() => void more(group.installation.id)}
							type="button"
						>
							{group.loadingMore
								? "Loading..."
								: `More from ${group.installation.account.login}`}
						</button>
					))}
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
				aria-controls={panelId}
				aria-expanded={open}
				aria-haspopup="listbox"
				className="btn btn-sm btn-ghost min-w-0 max-w-40 shrink-0 gap-1.5 sm:max-w-64"
				onClick={() => setOpen(value => !value)}
				ref={trigger}
				type="button"
			>
				<span className="truncate">{current?.fullName ?? "Choose repository"}</span>
				<CaretDownIcon aria-hidden="true" className="shrink-0" size={14} />
			</button>
			{popup}
		</>
	);
}
