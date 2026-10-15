import { ChevronIcon } from "@chopin/icons";

import { DecisionCard, SidecarCard } from "@chopin/editor";
import { AuditPlate } from "../frame";

export function DecisionsPlate() {
	return (
		<AuditPlate
			description="Outstanding, answered, resolved, orphaned, and deliberately empty records."
			item="decisions"
			title="Decisions"
		>
			<div className="design-audit-card-grid">
				<SidecarCard label="Decision">
					<strong>Which density should the navigation use?</strong>
					<div className="design-audit-choice-stack">
						<button className="btn btn-md btn-secondary" type="button">Compact</button>
						<button className="btn btn-md btn-secondary" type="button">Comfortable</button>
					</div>
				</SidecarCard>
				<DecisionCard
					value={{
						at: "2026-08-28T10:00:00.000Z",
						by: "maggieappleton",
						id: "audit-decision",
						notes: [{
							by: "maggieappleton",
							text: "Use compact rows, with comfortable section spacing.",
						}],
						quote: "Navigation density",
					}}
				/>
			</div>
			<button
				aria-expanded="true"
				className="btn btn-sm btn-ghost design-audit-resolved-toggle"
				type="button"
			>
				<ChevronIcon className="rotate-90" size={14} />
				<span>3</span>
				<span>resolved</span>
			</button>
		</AuditPlate>
	);
}
