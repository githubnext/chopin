import { AuditPlate, StateLabel } from "../frame";

export function IdentityPlate() {
	return (
		<AuditPlate
			description="Loading identity and shared editing indicators shown in their product contexts."
			item="identity"
			title="Identity and collaboration"
		>
			<div className="design-audit-identity-grid">
				<div>
					<StateLabel>Avatar image loading</StateLabel>
					<div className="design-audit-identity-row">
						<img
							alt=""
							className="design-audit-avatar-loading"
							src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E"
						/>
						<div>
							<strong>Maggie Appleton</strong>
							<span>Joining the document…</span>
						</div>
					</div>
				</div>
				<div>
					<StateLabel>Editing this question</StateLabel>
					<div className="design-audit-question-context">
						<header>
							<strong>Rollout</strong>
							<span aria-label="Editing this question" className="design-audit-collaborator-badges">
								<span>@maggieappleton</span>
								<span>@olivia</span>
							</span>
						</header>
						<p>How should we introduce the new document workflow?</p>
					</div>
				</div>
			</div>
		</AuditPlate>
	);
}
