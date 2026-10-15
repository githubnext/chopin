import { MessageIcon, SearchIcon } from "@chopin/icons";

import { AuditPlate } from "../frame";

export function EmptyStatesPlate() {
	return (
		<AuditPlate
			description="First-use, no-results, and unavailable states provide a next step."
			item="empty"
			title="Empty states"
		>
			<div className="design-audit-empty-grid">
				<div>
					<strong>No document open</strong>
					<span>Pick one from the sidebar or start a new one.</span>
					<button className="btn btn-sm btn-secondary" type="button">New document</button>
				</div>
				<div>
					<span className="design-audit-empty-sidebar-row">No documents</span>
					<span className="design-audit-empty-sidebar-row">No archived documents</span>
				</div>
				<div>
					<SearchIcon size={24} />
					<strong>No results</strong>
					<span>Try a shorter search or clear the filters.</span>
					<button className="btn btn-md btn-secondary" type="button">Clear search</button>
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
