import { MessageIcon } from "@chopin/icons";
import { useRef } from "react";

import { DocumentSearchResults } from "../../document-search-dialog";
import { AuditPlate, StateLabel } from "../frame";
import { auditProject, AuditSidebarProject } from "./document-fixtures";

function EmptySearch() {
	let input = useRef<HTMLInputElement>(null);
	return (
		<DocumentSearchResults
			input={input}
			manyProjects={false}
			onChoose={() => {}}
			onRetry={() => {}}
			query="Typography"
			search={{ failedProjectIds: [], results: [], status: "ready" }}
		/>
	);
}

export function EmptyStatesPlate() {
	return (
		<AuditPlate
			description="First-use, no-results, and unavailable states."
			item="empty"
			title="Empty states"
		>
			<div className="design-audit-empty-grid">
				<div>
					<strong>No document open</strong>
					<span>Pick one from the sidebar or start a new one.</span>
					<button className="btn btn-sm btn-secondary" type="button">New document</button>
				</div>
				<div className="design-audit-empty-live">
					{[false, true].map(archiveMode => (
						<div key={String(archiveMode)}>
							<StateLabel>{archiveMode ? "Sidebar, archived" : "Sidebar"}</StateLabel>
							<AuditSidebarProject
								archiveMode={archiveMode}
								entry={auditProject({ channels: [], status: "ready" })}
							/>
						</div>
					))}
				</div>
				<div className="design-audit-empty-live">
					<div>
						<StateLabel>Document search</StateLabel>
						<div className="navigation-modal-content navigation-palette">
							<EmptySearch />
						</div>
					</div>
				</div>
				<div>
					<MessageIcon size={24} />
					<strong>Conversation unavailable</strong>
					<span>Reconnect to keep collaborating.</span>
					<button className="btn btn-md btn-secondary" type="button">Try again</button>
				</div>
			</div>
		</AuditPlate>
	);
}
