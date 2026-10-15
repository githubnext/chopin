import { useRef } from "react";

import { DocumentSearchField, DocumentSearchResults } from "../../document-search-dialog";
import { AuditPlate } from "../frame";
import { AUDIT_PROJECT, auditChannel } from "./document-fixtures";

import type { DocumentSearchState } from "../../document-search-dialog";

export const AUDIT_SEARCH: DocumentSearchState = {
	failedProjectIds: [],
	results: [
		auditChannel("design-notes", "Design notes"),
		auditChannel("design-system-audit", "Design system audit", {
			description: "Every foundation, control and surface in one place",
		}),
		auditChannel("design-review", "Design review", { archivedAt: "2026-09-01T09:00:00.000Z" }),
	].map(channel => ({ channel, project: AUDIT_PROJECT })),
	status: "ready",
};

/** The live document search palette, outside its modal so the plate can show it in place. */
export function ListsPlate() {
	let input = useRef<HTMLInputElement>(null);
	return (
		<AuditPlate
			description="The document search palette's result list. Typing highlights the first match; arrows, Home, End, and the pointer move the highlight."
			item="lists"
			title="Lists"
		>
			<div className="navigation-modal-content navigation-palette">
				<DocumentSearchField input={input} onQuery={() => {}} query="Design" />
				<DocumentSearchResults
					input={input}
					manyProjects={false}
					onChoose={() => {}}
					onRetry={() => {}}
					query="Design"
					search={AUDIT_SEARCH}
				/>
			</div>
		</AuditPlate>
	);
}
