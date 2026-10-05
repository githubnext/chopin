import { CheckIcon, LoaderIcon, SearchIcon } from "@chopin/icons";
import { useEffect, useRef, useState } from "react";

import * as Api from "./api";
import { NavigationDialog } from "./navigation-dialog";
import {
	installedRepositoryGroups,
	loadRepositorySnapshot,
	readRepositoryCache,
	repositoryCacheIsStale,
	writeRepositoryCache,
} from "./repository-cache";
import { TerminalAlert } from "./terminal-alert";

import type { RepositorySnapshot } from "./repository-cache";
import type { NavigationDialogMotion } from "./navigation-dialog";

function message(error: unknown): string {
	return error instanceof Error ? error.message : "Could not load repositories.";
}

export function AddProjectDialog(
	{
		added,
		motion,
		onAdded,
		onDismiss,
		userId,
	}: {
		added: Api.NavigationProject[];
		motion: NavigationDialogMotion;
		onAdded: (project: Api.NavigationProject) => void;
		onDismiss: () => void;
		userId: string;
	},
) {
	let input = useRef<HTMLInputElement>(null);
	let [snapshot, setSnapshot] = useState<RepositorySnapshot | undefined>(() =>
		readRepositoryCache(userId)
	);
	let [error, setError] = useState<unknown>();
	let [query, setQuery] = useState("");
	let [retry, setRetry] = useState(0);
	let [adding, setAdding] = useState<string>();

	useEffect(() => {
		let active = true;
		let cached = readRepositoryCache(userId);
		if (cached) setSnapshot(cached);
		setError(undefined);
		if (retry === 0 && cached && !repositoryCacheIsStale(cached)) return;
		loadRepositorySnapshot(userId, cached, value => {
			if (active) setSnapshot(value);
		}).then(value => {
			if (active) {
				writeRepositoryCache(value);
				setSnapshot(value);
			}
		}, reason => {
			if (active) setError(reason);
		});
		return () => {
			active = false;
		};
	}, [retry, userId]);

	let normalized = query.trim().toLocaleLowerCase();
	let repositories = snapshot
		? installedRepositoryGroups(snapshot).flatMap(group => group.repositories)
		: [];
	let addedIds = new Set(added.map(project => project.repositoryId));
	let visible = repositories.filter(repository =>
		!normalized || `${repository.owner}/${repository.name}`.toLocaleLowerCase().includes(normalized)
	);

	async function select(repository: Api.Repository) {
		if (adding || addedIds.has(repository.id)) return;
		setAdding(repository.id);
		setError(undefined);
		try {
			onAdded(await Api.addProject(repository.owner, repository.name));
			onDismiss();
		} catch (reason) {
			setError(reason);
			setAdding(undefined);
		}
	}

	return (
		<NavigationDialog
			initialFocus={input}
			motion={motion}
			onDismiss={onDismiss}
			palette
			title="Add project"
		>
			<div className="navigation-palette-search">
				<SearchIcon aria-hidden="true" />
				<label className="sr-only" htmlFor="add-project-search">Search repositories</label>
				<input
					className="navigation-palette-input"
					id="add-project-search"
					onChange={event => setQuery(event.target.value)}
					placeholder="Search repositories…"
					ref={input}
					value={query}
				/>
			</div>
			<div className="navigation-palette-list" aria-busy={!snapshot && error === undefined}>
				{!snapshot && error === undefined && (
					<p className="navigation-palette-status">
						<LoaderIcon aria-hidden="true" data-palette-loader="" />
						Loading repositories
					</p>
				)}
				{error !== undefined && (
					<div className="navigation-palette-status flex-col">
						<TerminalAlert className="text-destructive-ink">{message(error)}</TerminalAlert>
						<button
							className="btn btn-sm btn-secondary"
							onClick={() => setRetry(value => value + 1)}
							type="button"
						>
							Try again
						</button>
					</div>
				)}
				{snapshot && visible.length === 0 && error === undefined && (
					<p className="navigation-palette-status">
						{normalized ? "No matching repositories" : "No accessible repositories"}
					</p>
				)}
				{visible.map(repository => {
					let alreadyAdded = addedIds.has(repository.id);
					let busy = adding === repository.id;
					return (
						<button
							aria-busy={busy || undefined}
							aria-label={`${repository.owner}/${repository.name}${alreadyAdded ? ", added" : ""}`}
							className="navigation-palette-option"
							disabled={alreadyAdded || busy}
							key={repository.id}
							onClick={() => void select(repository)}
							type="button"
						>
							<span
								className={`min-w-0 flex-1 truncate ${
									alreadyAdded ? "text-text-tertiary" : "text-text-primary"
								}`}
							>
								<span className="text-text-tertiary">{repository.owner}/</span>
								{repository.name}
							</span>
							{alreadyAdded
								? (
									<span className="flex shrink-0 items-center gap-1 text-xs text-text-tertiary">
										<CheckIcon aria-hidden="true" />
										Added
									</span>
								)
								: (
									<span className="navigation-palette-hint">
										{busy ? "Adding…" : "Add"}
									</span>
								)}
						</button>
					);
				})}
			</div>
			<div className="navigation-palette-footer">
				<a href="/auth/github/install">Manage repository access</a>
			</div>
		</NavigationDialog>
	);
}
