import { MAX_WATCHED_REPOSITORIES } from "./sidebar-decision-watch";

import type { Sidebar } from "@chopin/protocol";
import type * as Api from "./api";
import type { ProjectDocuments } from "./document-actions";

export type DecisionWatchPlan = {
	watched: Sidebar.WatchedRepository[];
	/** Available projects past the watch cap, kept fresh by bounded HTTP refreshes instead. */
	unwatched: Api.NavigationProject[];
};

/**
 * Split the sidebar's projects between live counts and the HTTP fallback. The project
 * holding the open document comes first, then projects in sidebar order, so the
 * per-socket cap covers what is on screen before anything scrolled out of view.
 */
export function decisionWatchPlan(
	projects: ProjectDocuments[],
	priorityRepositoryId?: string,
): DecisionWatchPlan {
	let ordered = projects.filter(({ project }) => project.available)
		.sort((first, second) =>
			Number(second.project.repositoryId === priorityRepositoryId)
				- Number(first.project.repositoryId === priorityRepositoryId)
			|| first.project.position - second.project.position
		);
	return {
		watched: ordered.slice(0, MAX_WATCHED_REPOSITORIES).map(({ project, documents }) => ({
			repositoryId: project.repositoryId,
			owner: project.repositoryOwner,
			name: project.repositoryName,
			channelIds: documents.channels.map(channel => channel.id),
		})),
		unwatched: ordered.slice(MAX_WATCHED_REPOSITORIES).map(({ project }) => project),
	};
}

export const FALLBACK_REFRESH_BATCH = 10;

/**
 * The next unwatched projects to refresh over HTTP, continuing after the last one
 * refreshed, so every project is reached in turn without a burst of requests.
 */
export function fallbackRefreshBatch(
	unwatched: Api.NavigationProject[],
	after?: string,
	limit = FALLBACK_REFRESH_BATCH,
): Api.NavigationProject[] {
	let start = unwatched.findIndex(project => project.repositoryId === after) + 1;
	return Array.from(
		{ length: Math.min(limit, unwatched.length) },
		(_, index) => unwatched[(start + index) % unwatched.length]!,
	);
}
