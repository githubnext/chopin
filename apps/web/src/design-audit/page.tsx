import { AuditFrame, AuditSection } from "./frame";
import { AUDIT_INVENTORY } from "./inventory";

import "./styles.css";

export function DesignAuditPage() {
	return (
		<AuditFrame groups={AUDIT_INVENTORY}>
			{AUDIT_INVENTORY.map(group => (
				<AuditSection id={group.id} key={group.id} title={group.label}>
					<p className="design-audit-section-summary">
						{group.items.length} component {group.items.length === 1 ? "family" : "families"}
					</p>
				</AuditSection>
			))}
		</AuditFrame>
	);
}
