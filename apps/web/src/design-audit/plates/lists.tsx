import { CheckIcon, DocumentIcon, SearchIcon } from "@chopin/icons";

import { AuditPlate } from "../frame";

export function ListsPlate() {
	return (
		<AuditPlate
			description="Rows share one inset, target height, and selected treatment."
			item="lists"
			title="Lists"
		>
			<div className="design-audit-surface-list" role="listbox" aria-label="Documents">
				<div role="option" aria-selected="false">
					<DocumentIcon size={14} />Design notes
				</div>
				<div role="option" aria-selected="true">
					<DocumentIcon size={14} />Design system audit<CheckIcon size={14} />
				</div>
				<div role="option" aria-selected="false" data-audit-state="hover">
					<DocumentIcon size={14} />Editor architecture
				</div>
			</div>
			<div className="design-audit-empty-row">
				<SearchIcon size={14} />
				<span>No matching documents</span>
			</div>
		</AuditPlate>
	);
}
