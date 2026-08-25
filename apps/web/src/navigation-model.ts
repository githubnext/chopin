import { childDocumentPath, documentPath } from "@chopin/protocol/document-url";

import type { NavigationProject, ResearchParentChannel } from "./api";
import type { ResearchOpener } from "@chopin/editor";
import type { Research } from "@chopin/protocol";
import type { ProjectDocuments } from "./document-actions";
import type { DocumentRouteIdentitySource } from "./document-route-swap";

export type NavigationMode = "drawer" | "inline";

export type NavigationRoute =
	| DocumentRouteIdentitySource
	| { page: "repositories" }
	| { page: "repository"; owner: string; repository: string };

export const NAVIGATION_MEDIA = "(max-width: 1023px)";

export function isDocumentWorkspaceRoute(
	route: NavigationRoute,
): route is DocumentRouteIdentitySource {
	return route.page === "channel" || route.page === "document" || route.page === "child";
}

export function navigationMode(
	matchMedia: (query: string) => { matches: boolean },
): NavigationMode {
	return matchMedia(NAVIGATION_MEDIA).matches ? "drawer" : "inline";
}

export function activeProject(
	projects: ProjectDocuments[],
	documentId: string | undefined,
	repositoryId?: string,
): NavigationProject | undefined {
	if (repositoryId) {
		return projects.find(({ project }) => project.repositoryId === repositoryId)?.project;
	}
	if (!documentId) return undefined;
	return projects.find(({ documents, project }) =>
		project.available && documents.channels.some(channel => channel.id === documentId)
	)?.project;
}

export function canManageProject(project: NavigationProject): boolean {
	return !!project.repository
		&& (project.repository.permissions.push || project.repository.permissions.admin);
}

export function documentDestination(
	projects: ProjectDocuments[],
	documentId: string,
	path?: string,
): string {
	if (path) return path;
	for (let { documents, project } of projects) {
		let channel = documents.channels.find(candidate => candidate.id === documentId);
		if (channel) {
			if (channel.parentChannelId) {
				let parent = documents.channels.find(candidate => candidate.id === channel.parentChannelId);
				return parent
					? childDocumentPath(
						project.repositoryOwner,
						project.repositoryName,
						parent.slug,
						channel.slug,
					)
					: `/channels/${encodeURIComponent(documentId)}`;
			}
			return documentPath(project.repositoryOwner, project.repositoryName, channel.slug);
		}
	}
	return `/channels/${encodeURIComponent(documentId)}`;
}

export function researchChildDestination(
	parent: Pick<ResearchParentChannel, "repositoryOwner" | "repositoryName" | "slug">,
	child: Pick<Research.ReadyChild, "slug">,
): string {
	return childDocumentPath(
		parent.repositoryOwner,
		parent.repositoryName,
		parent.slug,
		child.slug,
	);
}

export function researchChildNavigation(
	parent: Pick<ResearchParentChannel, "repositoryOwner" | "repositoryName" | "slug">,
	child: Pick<Research.ReadyChild, "slug">,
	opener: ResearchOpener,
): { destination: string; opener: ResearchOpener } {
	return { destination: researchChildDestination(parent, child), opener };
}

export function beginProjectCreation(
	creating: ReadonlySet<string>,
	projectId: string,
): Set<string> {
	return new Set(creating).add(projectId);
}

export function finishProjectCreation(
	creating: ReadonlySet<string>,
	projectId: string,
): Set<string> {
	let next = new Set(creating);
	next.delete(projectId);
	return next;
}

export function landingDocument(
	projects: ProjectDocuments[],
	lastDocumentId?: string,
): string | undefined {
	let available = projects.filter(({ documents }) => documents.status !== "unavailable");
	let channels = available.flatMap(({ documents }) => documents.channels);
	if (lastDocumentId) {
		let last = channels.find(channel => channel.id === lastDocumentId);
		if (last && !last.archivedAt) return last.id;
		if (!last && available.some(({ documents }) => documents.status === "loading")) {
			return lastDocumentId;
		}
	}
	if (available.some(({ documents }) => documents.status === "loading")) return undefined;
	return channels.find(channel => !channel.archivedAt && !channel.parentChannelId)?.id;
}
