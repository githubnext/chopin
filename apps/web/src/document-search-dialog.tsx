import { LoaderIcon, SearchIcon } from "@chopin/icons";
import { useEffect, useRef, useState } from "react";

import * as Api from "./api";
import { NavigationDialog } from "./navigation-dialog";
import { PaletteListbox } from "./navigation-palette";

import type { NavigationDialogMotion } from "./navigation-dialog";

export type DocumentSearchResult = {
	project: Api.NavigationProject;
	channel: Api.Channel;
};

export async function searchAvailableDocuments(
	projects: Api.NavigationProject[],
	query: string,
	includeArchived: boolean,
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
							{
								cursor,
								includeArchived,
								query: query.trim() || undefined,
								signal,
							},
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

type SearchState =
	| { status: "loading" }
	| { status: "ready"; results: DocumentSearchResult[]; failedProjectIds: string[] }
	| { status: "error"; message: string };

// Last unfiltered result. It is valid only for the same user, project set and
// document catalogue identity, so mutations never leave stale rows behind.
let recent: { key: string; source: unknown; results: DocumentSearchResult[] } | undefined;

let recentKey = (userId: string, projects: Api.NavigationProject[], includeArchived: boolean) =>
	`${userId}:${includeArchived}:${projects.map(project => project.repositoryId).join(",")}`;

function rememberRecent(
	key: string,
	source: unknown,
	result: Awaited<ReturnType<typeof searchAvailableDocuments>>,
) {
	if (!result.failedProjectIds.length) recent = { key, source, results: result.results };
}

export function warmRecentSearch(
	userId: string,
	projects: Api.NavigationProject[],
	includeArchived: boolean,
	source: unknown,
) {
	return searchAvailableDocuments(projects, "", includeArchived).then(
		result => rememberRecent(recentKey(userId, projects, includeArchived), source, result),
		() => {},
	);
}

export function DocumentSearchDialog(
	{
		includeArchived,
		motion,
		onDismiss,
		onSelect,
		projects,
		source,
		userId,
	}: {
		includeArchived: boolean;
		motion: NavigationDialogMotion;
		onDismiss: () => void;
		onSelect: (documentId: string) => void;
		projects: Api.NavigationProject[];
		source: unknown;
		userId: string;
	},
) {
	let input = useRef<HTMLInputElement>(null);
	let [query, setQuery] = useState("");
	let [retry, setRetry] = useState(0);
	let key = recentKey(userId, projects, includeArchived);
	let cached = () => recent?.key === key && recent.source === source ? recent : undefined;
	let [search, setSearch] = useState<SearchState>(() => {
		let hit = cached();
		return hit
			? { status: "ready", results: hit.results, failedProjectIds: [] }
			: { status: "loading" };
	});

	useEffect(() => {
		let active = true;
		let controller = new AbortController();
		let timer = window.setTimeout(() => {
			let hit = query.trim() ? undefined : cached();
			setSearch(
				hit
					? { status: "ready", results: hit.results, failedProjectIds: [] }
					: { status: "loading" },
			);
			searchAvailableDocuments(
				projects,
				query,
				includeArchived,
				Api.channels,
				controller.signal,
			).then(result => {
				if (!active) return;
				if (!query.trim()) rememberRecent(key, source, result);
				setSearch({ status: "ready", ...result });
			}, error => {
				if (active && !controller.signal.aborted) {
					setSearch({
						status: "error",
						message: error instanceof Error ? error.message : "Could not search documents.",
					});
				}
			});
		}, 150);
		return () => {
			active = false;
			window.clearTimeout(timer);
			controller.abort();
		};
	}, [includeArchived, key, projects, query, retry, source]);

	let results = search.status === "ready" ? search.results : [];
	let manyProjects = projects.length > 1;
	return (
		<NavigationDialog
			initialFocus={input}
			motion={motion}
			onDismiss={onDismiss}
			palette
			title="Search documents"
		>
			<div className="navigation-palette-search">
				<SearchIcon aria-hidden="true" />
				<label className="sr-only" htmlFor="document-search">Search documents</label>
				<input
					className="navigation-palette-input"
					id="document-search"
					onChange={event => setQuery(event.target.value)}
					placeholder="Search documents…"
					ref={input}
					value={query}
				/>
			</div>
			<div className="navigation-palette-list" aria-busy={search.status === "loading"}>
				{search.status === "loading" && (
					<p className="navigation-palette-status" role="status">
						<LoaderIcon aria-hidden="true" data-palette-loader="" />
						Searching documents
					</p>
				)}
				{search.status === "error" && (
					<div className="navigation-palette-status flex-col">
						<p className="text-destructive-ink" role="alert">{search.message}</p>
						<button
							className="btn btn-sm btn-secondary"
							onClick={() => setRetry(value => value + 1)}
							type="button"
						>
							Try again
						</button>
					</div>
				)}
				{search.status === "ready" && search.failedProjectIds.length > 0 && (
					<p className="px-2.5 py-1.5 text-xs text-destructive-ink" role="status">
						Some Projects could not be searched.
					</p>
				)}
				{search.status === "ready" && results.length === 0 && (
					<p className="navigation-palette-status" role="status">
						{query.trim() ? "No matching documents" : "No documents yet"}
					</p>
				)}
				{results.length > 0 && (
					<PaletteListbox
						input={input}
						itemKey={({ channel }) => channel.id}
						items={results}
						label="Documents"
						onChoose={({ channel }) => {
							onSelect(channel.id);
							onDismiss();
						}}
						query={query}
						renderItem={({ channel, project }) => (
							<>
								<span className="flex min-w-0 flex-1 items-baseline gap-2">
									<span className="min-w-0 truncate text-text-primary">{channel.title}</span>
									{channel.description && (
										<span className="min-w-0 flex-1 truncate text-text-tertiary">
											{channel.description}
										</span>
									)}
								</span>
								{channel.archivedAt && <span className="document-status-badge">Archived</span>}
								{manyProjects && (
									<span className="shrink-0 text-xs text-text-tertiary">
										{project.repositoryOwner}/{project.repositoryName}
									</span>
								)}
							</>
						)}
					/>
				)}
			</div>
		</NavigationDialog>
	);
}
