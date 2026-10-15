import { SidecarCard } from "@chopin/editor";
import { AuditPlate } from "../frame";

export function ResolvedCommentsPlate() {
	return (
		<AuditPlate
			description="Resolved discussion records retain empty and orphaned relationship states."
			item="resolved-comments"
			title="Resolved comments"
		>
			<div className="design-audit-resolved-grid">
				<SidecarCard label="Comment" settled status={<span>Accepted by @maggieappleton</span>}>
					<blockquote>Give controls a little more room.</blockquote>
					<p>Raised the shared horizontal inset.</p>
				</SidecarCard>
				<SidecarCard label="Comment" settled status={<span>Resolved</span>}>
					<p className="design-audit-muted">No prose was linked intentionally.</p>
				</SidecarCard>
				<SidecarCard label="Comment" settled status={<span>Orphaned</span>}>
					<p className="design-audit-muted">
						The original passage can no longer be located safely.
					</p>
				</SidecarCard>
			</div>
		</AuditPlate>
	);
}
