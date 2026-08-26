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
			title="Add Project"
		>
			<div className="mt-4">
				<label className="sr-only" htmlFor="add-project-search">Search repositories</label>
				<input
					className="field h-9 w-full px-3 text-sm"
					id="add-project-search"
					onChange={event => setQuery(event.target.value)}
					placeholder="Search repositories"
					ref={input}
					value={query}
				/>
			</div>
			<div className="navigation-dialog-list" aria-busy={!snapshot && error === undefined}>
				{!snapshot && error === undefined && (
					<p className="text-sm text-text-tertiary">Loading repositories…</p>
				)}
				{error !== undefined && (
					<div>
						<TerminalAlert className="text-sm text-destructive-ink">
							{message(error)}
						</TerminalAlert>
						<button
							className="btn btn-sm btn-secondary mt-2"
							onClick={() => setRetry(value => value + 1)}
							type="button"
						>
							Try again
						</button>
					</div>
				)}
				{snapshot && visible.length === 0 && error === undefined && (
					<p className="text-sm text-text-tertiary">No accessible repositories found.</p>
				)}
				{visible.map(repository => {
					let alreadyAdded = addedIds.has(repository.id);
					return (
						<button
							className="navigation-dialog-option"
							disabled={alreadyAdded || adding === repository.id}
							key={repository.id}
							onClick={() => void select(repository)}
							type="button"
						>
							<span className="min-w-0">
								<span className="block truncate text-sm font-medium">{repository.name}</span>
								<span className="block truncate text-sm text-text-tertiary">
									{repository.owner}
								</span>
							</span>
							<span className="text-sm text-text-tertiary">
								{alreadyAdded ? "Added" : adding === repository.id ? "Adding…" : "Add"}
							</span>
						</button>
					);
				})}
			</div>
			<a
				className="mt-4 inline-flex text-sm font-medium text-brand underline"
				href="/auth/github/install"
			>
				Manage repository access
			</a>
		</NavigationDialog>
	);
}
