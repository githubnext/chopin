import { useEffect, useRef, useState } from "react";

import * as Api from "./api";
import { NavigationDialog } from "./navigation-dialog";

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

export function DocumentSearchDialog(
	{
		includeArchived,
		onDismiss,
		onSelect,
		projects,
	}: {
		includeArchived: boolean;
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
			searchAvailableDocuments(
				projects,
				query,
				includeArchived,
				Api.channels,
				controller.signal,
			).then(result => {
				if (active) setSearch({ status: "ready", ...result });
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
	}, [includeArchived, projects, query, retry]);

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
							<span className="flex min-w-0 items-center gap-2 text-sm font-medium">
								<span className="truncate">{channel.title}</span>
								{channel.archivedAt && <span className="document-status-badge">Archived</span>}
							</span>
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
