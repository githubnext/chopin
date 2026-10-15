import { ProjectSidebarProject } from "../../project-sidebar";

import type * as Api from "../../api";
import type { ProjectDocuments } from "../../document-actions";

export const AUDIT_PROJECT: Api.NavigationProject = {
	available: true,
	position: 0,
	repository: {
		fullName: "githubnext/chopin",
		id: "R_audit",
		name: "chopin",
		owner: "githubnext",
		permissions: { admin: false, pull: true, push: true },
	},
	repositoryId: "R_audit",
	repositoryName: "chopin",
	repositoryOwner: "githubnext",
};

export function auditChannel(
	id: string,
	title: string,
	extra: Partial<Api.Channel> = {},
): Api.Channel {
	return {
		createdAt: "2026-10-01T09:00:00.000Z",
		createdBy: "MaggieAppleton",
		descriptionRevision: 0,
		id,
		repositoryId: AUDIT_PROJECT.repositoryId,
		repositoryName: AUDIT_PROJECT.repositoryName,
		repositoryOwner: AUDIT_PROJECT.repositoryOwner,
		revision: 1,
		slug: id,
		title,
		updatedAt: "2026-10-01T09:00:00.000Z",
		...extra,
	};
}

export function auditProject(
	documents: ProjectDocuments["documents"],
	project: Partial<Api.NavigationProject> = {},
): ProjectDocuments {
	return { documents, project: { ...AUDIT_PROJECT, ...project } };
}

/** The live sidebar Project, expanded inside the sidebar context its styles need. */
export function AuditSidebarProject(
	{ archiveMode = false, currentDocumentId, entry }: {
		archiveMode?: boolean;
		currentDocumentId?: string;
		entry: ProjectDocuments;
	},
) {
	return (
		<div className="project-sidebar" data-tooltip-edge="">
			<ul className="project-sidebar-projects">
				<ProjectSidebarProject
					archiveMode={archiveMode}
					currentDocumentId={currentDocumentId}
					entry={entry}
					expanded
					focus={false}
					onCreateDocument={() => {}}
					onDocumentAction={() => {}}
					onFocused={() => {}}
					onLoadMore={() => {}}
					onToggle={() => {}}
					pendingCreations={new Map()}
					revealed={false}
				/>
			</ul>
		</div>
	);
}
