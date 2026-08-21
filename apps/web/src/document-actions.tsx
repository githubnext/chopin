import { useEffect, useRef, useState } from "react";

import * as Api from "./api";
import { DocumentRename } from "./document-rename";
import { NavigationDialog } from "./navigation-dialog";
import {
	installedRepositoryGroups,
	loadRepositorySnapshot,
	readRepositoryCache,
	writeRepositoryCache,
} from "./repository-cache";

import type { RepositorySnapshot } from "./repository-cache";

export type DocumentLoadState =
	| { status: "loading"; channels: Api.Channel[]; nextCursor?: string }
	| { status: "ready"; channels: Api.Channel[]; nextCursor?: string }
	| { status: "error"; channels: Api.Channel[]; nextCursor?: string; message: string };

export type LoadedDocuments = Record<string, DocumentLoadState>;

export type ProjectDocuments = {
	project: Api.NavigationProject;
	documents: DocumentLoadState | { status: "unavailable"; channels: [] };
};

export function projectDocuments(
	navigation: Api.Navigation,
	documents: LoadedDocuments,
): ProjectDocuments[] {
	return navigation.projects.map(project => ({
		project,
		documents: !project.available
			? { status: "unavailable", channels: [] }
			: documents[project.repositoryId] ?? beginDocumentLoad(),
	}));
}

export function beginDocumentLoad(current?: DocumentLoadState): DocumentLoadState {
	return {
		status: "loading",
		channels: current?.channels ?? [],
		...(current?.nextCursor ? { nextCursor: current.nextCursor } : {}),
	};
}

export function completeDocumentPage(
	current: DocumentLoadState,
	channels: Api.Channel[],
	nextCursor?: string,
): DocumentLoadState {
	let byId = new Map(current.channels.map(channel => [channel.id, channel]));
	for (let channel of channels) byId.set(channel.id, channel);
	return {
		status: "ready",
		channels: [...byId.values()],
		...(nextCursor ? { nextCursor } : {}),
	};
}

export function failDocumentLoad(
	current: DocumentLoadState,
	error: unknown,
): DocumentLoadState {
	return {
		status: "error",
		channels: current.channels,
		...(current.nextCursor ? { nextCursor: current.nextCursor } : {}),
		message: error instanceof Error ? error.message : "Could not load documents",
	};
}

export type DocumentSearchResult = {
	project: Api.NavigationProject;
	channel: Api.Channel;
};

export async function searchAvailableDocuments(
	projects: Api.NavigationProject[],
	query: string,
	load: typeof Api.channels = Api.channels,
	signal?: AbortSignal,
): Promise<{ results: DocumentSearchResult[]; failedProjectIds: string[] }> {
	let searched = await Promise.all(
		projects.filter(project => project.available).map(
			async project => {
				let channels: Api.Channel[] = [];
				let cursor: string | undefined;
				try {
					do {
						let page = await load(
							project.repositoryOwner,
							project.repositoryName,
							cursor,
							query.trim() || undefined,
							signal,
						);
						channels.push(...page.channels);
						cursor = page.nextCursor;
					} while (cursor);
					return { channels, project };
				} catch (error) {
					if (signal?.aborted) throw error;
					return { channels: [], error, project };
				}
			},
		),
	);
	return {
		results: searched.flatMap(({ channels, project }) =>
			channels.map(channel => ({ channel, project }))
		),
		failedProjectIds: searched.filter(result => "error" in result)
			.map(result => result.project.repositoryId),
	};
}

export function newestDocument(current: Api.Channel, replacement: Api.Channel): Api.Channel {
	return current.id === replacement.id && current.updatedAt > replacement.updatedAt
		? current
		: replacement;
}

export function replaceLoadedDocument(
	documents: LoadedDocuments,
	replacement: Api.Channel,
): LoadedDocuments {
	let current = documents[replacement.repositoryId];
	if (!current) {
		return {
			...documents,
			[replacement.repositoryId]: { status: "loading", channels: [replacement] },
		};
	}
	let found = current.channels.some(channel => channel.id === replacement.id);
	return {
		...documents,
		[replacement.repositoryId]: {
			...current,
			channels: found
				? current.channels.map(channel =>
					channel.id === replacement.id ? newestDocument(channel, replacement) : channel
				)
				: [...current.channels, replacement],
		},
	};
}

export function updateLoadedDocument(
	documents: LoadedDocuments,
	documentId: string,
	update: Pick<Api.Channel, "title" | "slug" | "updatedAt">,
): LoadedDocuments {
	for (let [repositoryId, state] of Object.entries(documents)) {
		if (!state.channels.some(channel => channel.id === documentId)) continue;
		return {
			...documents,
			[repositoryId]: {
				...state,
				channels: state.channels.map(channel =>
					channel.id === documentId && channel.updatedAt <= update.updatedAt
						? { ...channel, ...update }
						: channel
				),
			},
		};
	}
	return documents;
}

function message(error: unknown, fallback: string): string {
	return error instanceof Error ? error.message : fallback;
}

export function AddProjectDialog(
	{
		added,
		onAdded,
		onDismiss,
		userId,
	}: {
		added: Api.NavigationProject[];
		onAdded: (project: Api.NavigationProject) => void;
		onDismiss: () => void;
		userId: string;
	},
) {
	let input = useRef<HTMLInputElement>(null);
	let [snapshot, setSnapshot] = useState<RepositorySnapshot>();
	let [error, setError] = useState<unknown>();
	let [query, setQuery] = useState("");
	let [retry, setRetry] = useState(0);
	let [adding, setAdding] = useState<string>();

	useEffect(() => {
		let active = true;
		let cached = readRepositoryCache(userId);
		if (cached) setSnapshot(cached);
		setError(undefined);
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
		<NavigationDialog initialFocus={input} onDismiss={onDismiss} title="Add Project">
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
						<p className="text-sm text-destructive-ink" role="alert">
							{message(error, "Could not load repositories.")}
						</p>
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

export function DocumentSearchDialog(
	{
		onDismiss,
		onSelect,
		projects,
	}: {
		onDismiss: () => void;
		onSelect: (documentId: string) => void;
		projects: Api.NavigationProject[];
	},
) {
	let input = useRef<HTMLInputElement>(null);
	let [query, setQuery] = useState("");
	let [retry, setRetry] = useState(0);
	let [search, setSearch] = useState<
		| { status: "loading" }
		| { status: "ready"; results: DocumentSearchResult[]; failedProjectIds: string[] }
		| { status: "error"; message: string }
	>({ status: "loading" });

	useEffect(() => {
		let active = true;
		let controller = new AbortController();
		let timer = window.setTimeout(() => {
			setSearch({ status: "loading" });
			searchAvailableDocuments(projects, query, Api.channels, controller.signal).then(result => {
				if (active) setSearch({ status: "ready", ...result });
			}, error => {
				if (active && !controller.signal.aborted) {
					setSearch({ status: "error", message: message(error, "Could not search documents.") });
				}
			});
		}, 150);
		return () => {
			active = false;
			window.clearTimeout(timer);
			controller.abort();
		};
	}, [projects, query, retry]);

	let results = search.status === "ready" ? search.results : [];
	return (
		<NavigationDialog initialFocus={input} onDismiss={onDismiss} title="Search documents">
			<div className="mt-4">
				<label className="sr-only" htmlFor="document-search">Search documents</label>
				<input
					className="field h-9 w-full px-3 text-sm"
					id="document-search"
					onChange={event => setQuery(event.target.value)}
					placeholder="Search documents"
					ref={input}
					value={query}
				/>
			</div>
			<div className="navigation-dialog-list">
				{search.status === "loading" && (
					<p className="text-sm text-text-tertiary">Searching documents…</p>
				)}
				{search.status === "error" && (
					<div>
						<p className="text-sm text-destructive-ink" role="alert">{search.message}</p>
						<button
							className="btn btn-sm btn-secondary mt-2"
							onClick={() => setRetry(value => value + 1)}
							type="button"
						>
							Try again
						</button>
					</div>
				)}
				{search.status === "ready" && search.failedProjectIds.length > 0 && (
					<p className="text-sm text-destructive-ink" role="status">
						Some Projects could not be searched.
					</p>
				)}
				{search.status === "ready" && results.length === 0 && (
					<p className="text-sm text-text-tertiary">No documents found.</p>
				)}
				{results.map(({ channel, project }) => (
					<button
						className="navigation-dialog-option"
						key={channel.id}
						onClick={() => {
							onSelect(channel.id);
							onDismiss();
						}}
						type="button"
					>
						<span className="min-w-0">
							<span className="block truncate text-sm font-medium">{channel.title}</span>
							<span className="block truncate text-sm text-text-tertiary">
								{project.repositoryOwner}/{project.repositoryName}
							</span>
						</span>
					</button>
				))}
			</div>
		</NavigationDialog>
	);
}

export function RenameDocumentDialog(
	{
		channel,
		onDismiss,
		onRenamed,
	}: {
		channel: Api.Channel;
		onDismiss: () => void;
		onRenamed: (channel: Api.Channel) => void;
	},
) {
	return (
		<NavigationDialog onDismiss={onDismiss} title="Rename document">
			<DocumentRename
				channel={channel}
				className="mt-4"
				onCancel={onDismiss}
				onRenamed={detail => {
					onRenamed(detail.channel);
					onDismiss();
				}}
			/>
		</NavigationDialog>
	);
}
