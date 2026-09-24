import { AuditPlate } from "./frame";

export function Adoption() {
	return (
		<AuditPlate
			description="The visual foundation is shared; control adoption remains deliberate and visible."
			item="shared-adoption"
			title="One foundation, gradual adoption"
		>
			<div className="design-audit-adoption">
				<div>
					<h4>Shared foundation</h4>
					<p>Tokens, icons, and presentation primitives come from @chopin/visuals.</p>
				</div>
				<div>
					<h4>Adopted shared controls</h4>
					<ul aria-label="Adopted shared controls">
						<li>
							<strong>Select</strong>
							<span>Design audit field only</span>
						</li>
					</ul>
				</div>
			</div>
		</AuditPlate>
	);
}
