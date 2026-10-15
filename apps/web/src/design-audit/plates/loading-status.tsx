import { PlanStatus } from "@chopin/editor";
import { DecisionViewControl } from "../../decision-view-control";
import { AuditPlate, StateLabel } from "../frame";

import type { PlanStatusProps } from "@chopin/editor";

let STATUS_SPECIMENS: { label: string; status: PlanStatusProps }[] = [
	{ label: "Connected", status: { connection: "connected", synced: true } },
	{ label: "Loading", status: { synced: false } },
	{ label: "Busy", status: { busy: true, synced: true } },
	{ label: "Reconnect", status: { connection: "reconnecting", synced: true } },
	{ label: "Error", status: { failed: "Permission denied", synced: false } },
	{ label: "No access", status: { connection: "denied", synced: true } },
];

export function LoadingStatusPlate() {
	return (
		<AuditPlate
			description="Document status sits at the end of the document header row, silent while connected and idle."
			item="loading"
			title="Loading and status"
		>
			<div className="design-audit-status-grid">
				{STATUS_SPECIMENS.map(({ label, status }) => (
					<div key={label}>
						<StateLabel>{label}</StateLabel>
						<div className="design-audit-status-header hairline-b">
							<DecisionViewControl onView={() => {}} unanswered={0} view="plan" />
							<PlanStatus
								busy={status.busy}
								connection={status.connection}
								failed={status.failed}
								onReload={() => {}}
								synced={status.synced}
							/>
						</div>
					</div>
				))}
			</div>
		</AuditPlate>
	);
}
