import { CheckIcon, LoaderIcon, SearchIcon } from "@chopin/icons";
import { useEffect, useRef, useState } from "react";

import * as Api from "./api";
import { NavigationDialog } from "./navigation-dialog";
import { PaletteListbox } from "./navigation-palette";
import {
	installedRepositoryGroups,
	loadRepositorySnapshot,
	readRepositoryCache,
	repositoryCacheIsStale,
	writeRepositoryCache,
} from "./repository-snapshot";
import { TerminalAlert } from "./terminal-alert";

import type { RepositorySnapshot } from "./repository-snapshot";
import type { NavigationDialogMotion } from "./navigation-dialog";
import type { RefObject } from "react";

function message(error: unknown): string {
	return error instanceof Error ? error.message : "Could not load repositories.";
}

/** Take a repository out of the signed-in person's projects; its documents stay as they are. */
async function removeProject(repositoryId: string): Promise<void> {
	let result = await fetch(`/api/navigation/projects/${encodeURIComponent(repositoryId)}`, {
		method: "DELETE",
	});
	if (result.status === 204) return;
	let failure = await result.json().catch(() => undefined) as { error?: string } | undefined;
	throw new Api.ApiError(failure?.error ?? `request failed (${result.status})`, result.status);
}

/** A change to one repository that is under way. */
type Pending = "adding" | "removing";

/**
 * Choose which repositories are projects, as GitHub's multi-select repository picker does: each
 * row is a checkbox and the repository's name, projects listed first as it opens, and choosing a
 * row adds or removes it at once. It stays open for several changes and closes with Escape or a
 * click outside. With no projects yet, the first one added closes it, so a first run goes
 * straight to its documents.
 */
export function AddProjectDialog(
	{
		added,
		motion,
		onAdded,
		onDismiss,
		onRemoved,
		userId,
	}: {
		added: Api.NavigationProject[];
		motion: NavigationDialogMotion;
		/** A project was added; `closing` when the dialog closes with it, so focus can follow it. */
		onAdded: (project: Api.NavigationProject, closing: boolean) => void;
		onDismiss: () => void;
		onRemoved: (repositoryId: string) => void;
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
	let [pending, setPending] = useState<ReadonlyMap<string, Pending>>(new Map());
	/** Choices made here, shown at once and kept until the projects list agrees. */
	let [chosen, setChosen] = useState<ReadonlyMap<string, boolean>>(new Map());
	let firstRun = useRef(added.length === 0);
	/** Projects as the dialog opened, listed first; a choice made here never reorders the list. */
	let openedWith = useRef(new Set(added.map(project => project.repositoryId)));

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
	let isProject = (id: string) => chosen.get(id) ?? addedIds.has(id);
	let visible = repositories.filter(repository =>
		!normalized || `${repository.owner}/${repository.name}`.toLocaleLowerCase().includes(normalized)
	).sort((a, b) => Number(openedWith.current.has(b.id)) - Number(openedWith.current.has(a.id)));

	function settle(id: string, value?: boolean) {
		setPending(current => {
			let next = new Map(current);
			next.delete(id);
			return next;
		});
		setChosen(current => {
			let next = new Map(current);
			if (value === undefined) next.delete(id);
			else next.set(id, value);
			return next;
		});
	}

	async function toggle(repository: Api.Repository) {
		if (pending.has(repository.id)) return;
		let adding = !isProject(repository.id);
		setPending(current => new Map(current).set(repository.id, adding ? "adding" : "removing"));
		setChosen(current => new Map(current).set(repository.id, adding));
		setError(undefined);
		try {
			if (adding) {
				onAdded(await Api.addProject(repository.owner, repository.name), firstRun.current);
			} else {
				await removeProject(repository.id);
				onRemoved(repository.id);
			}
			settle(repository.id, adding);
			if (adding && firstRun.current) onDismiss();
		} catch (reason) {
			setError(reason);
			settle(repository.id);
		}
	}

	// Once the projects list agrees with a choice made here, the list is the truth again.
	useEffect(() => {
		setChosen(current => {
			let stale = [...current].filter(([id, value]) =>
				addedIds.has(id) === value && !pending.has(id)
			);
			if (stale.length === 0) return current;
			let next = new Map(current);
			for (let [id] of stale) next.delete(id);
			return next;
		});
	}, [added]);

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
					<p className="navigation-palette-status" role="status">
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
					normalized || repositories.length > 0
						? (
							<p className="navigation-palette-status" role="status">
								No matching repositories
							</p>
						)
						: (
							<div className="navigation-palette-status flex-col gap-1 text-center" role="status">
								<p className="font-medium text-text-primary">No repositories to add yet</p>
								<p className="max-w-[40ch] text-text-tertiary">
									Install the GitHub App for Chopin on the repositories you want to write about.
								</p>
								<a className="btn btn-sm btn-primary mt-2" href="/auth/github/install">
									Install the GitHub App for Chopin
								</a>
							</div>
						)
				)}
				{visible.length > 0 && (
					<RepositoryOptions
						input={input}
						isProject={isProject}
						onChoose={repository => void toggle(repository)}
						pending={pending}
						query={query}
						repositories={visible}
					/>
				)}
			</div>
			<div className="navigation-palette-footer">
				<a href="/auth/github/install">Manage repository access</a>
			</div>
		</NavigationDialog>
	);
}

/** Each repository a person can add, checked when it is one of their projects. */
export function RepositoryOptions(
	{ input, isProject, onChoose, pending, query, repositories }: {
		input: RefObject<HTMLInputElement | null>;
		isProject: (repositoryId: string) => boolean;
		onChoose: (repository: Api.Repository) => void;
		pending: ReadonlyMap<string, Pending>;
		query: string;
		repositories: Api.Repository[];
	},
) {
	return (
		<PaletteListbox
			checked={repository => isProject(repository.id)}
			input={input}
			itemKey={repository => repository.id}
			itemLabel={repository => `${repository.owner}/${repository.name}`}
			items={repositories}
			label="Repositories"
			onChoose={onChoose}
			query={query}
			renderItem={repository => {
				let member = isProject(repository.id);
				let busy = pending.get(repository.id);
				return (
					<>
						<span
							aria-hidden="true"
							className="navigation-palette-check"
							data-checked={member || undefined}
						>
							{busy
								? <LoaderIcon data-palette-loader="" size={12} />
								: member && <CheckIcon size={12} />}
						</span>
						<span className="min-w-0 flex-1 truncate text-text-primary">
							{repository.owner}/{repository.name}
						</span>
					</>
				);
			}}
		/>
	);
}
