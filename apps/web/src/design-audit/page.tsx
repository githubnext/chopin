import { AuditFrame, AuditSection } from "./frame";
import { Adoption } from "./adoption";
import { AuthoredContent } from "./authored-content";
import { Controls } from "./controls";
import { ColorControls } from "./color";
import { Foundations } from "./foundations";
import { AUDIT_INVENTORY } from "./inventory";
import { Surfaces } from "./surfaces";

import "@chopin/visuals/styles.css";
import "./controls.css";
import "./color.css";
import "./authored-content.css";
import "./foundations.css";
import "./surfaces.css";
import "./styles.css";

export function DesignAuditPage() {
	return (
		<AuditFrame groups={AUDIT_INVENTORY}>
			<AuditSection id="foundations" title="Foundations">
				<Adoption />
				<Foundations />
			</AuditSection>
			<AuditSection id="controls" title="Controls">
				<Controls />
			</AuditSection>
			<AuditSection id="color" title="Color controls">
				<ColorControls />
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
