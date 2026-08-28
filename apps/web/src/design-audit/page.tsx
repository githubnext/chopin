import { AuditFrame, AuditSection } from "./frame";
import { AuthoredContent } from "./authored-content";
import { Controls } from "./controls";
import { Foundations } from "./foundations";
import { AUDIT_INVENTORY } from "./inventory";
import { Surfaces } from "./surfaces";

import "./controls.css";
import "./authored-content.css";
import "./foundations.css";
import "./surfaces.css";
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
			<AuditSection id="surfaces" title="Application surfaces">
				<Surfaces />
			</AuditSection>
			<AuditSection id="authored-content" title="Authored content">
				<AuthoredContent />
			</AuditSection>
		</AuditFrame>
	);
}
