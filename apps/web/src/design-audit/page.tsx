import { AuditFrame, AuditSection } from "./frame";
import { Controls } from "./controls";
import { Foundations } from "./foundations";
import { AUDIT_INVENTORY } from "./inventory";

import "./controls.css";
import "./foundations.css";
import "./styles.css";

export function DesignAuditPage() {
	return (
		<AuditFrame groups={AUDIT_INVENTORY}>
			<AuditSection id="foundations" title="Foundations">
				<Foundations />
			</AuditSection>
			<AuditSection id="controls" title="Controls">
				<Controls />
			</AuditSection>
			{AUDIT_INVENTORY.slice(2).map(group => (
				<AuditSection id={group.id} key={group.id} title={group.label}>
					<p className="design-audit-section-summary">{group.items.length} component families</p>
				</AuditSection>
			))}
		</AuditFrame>
	);
}
