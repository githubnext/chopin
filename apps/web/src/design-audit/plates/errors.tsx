import { TerminalAlert } from "../../terminal-alert";
import { AuditPlate } from "../frame";

export function ErrorsPlate() {
	return (
		<AuditPlate
			description="Inline, terminal, and recoverable failures use one destructive ink role."
			item="errors"
			title="Errors"
		>
			<div className="design-audit-error-stack">
				<TerminalAlert>Enter a document name.</TerminalAlert>
				<TerminalAlert>Could not open this document. Reloading may help.</TerminalAlert>
				<div className="design-audit-recoverable-error">
					<TerminalAlert>Research stopped before it finished.</TerminalAlert>
					<button className="btn btn-sm btn-secondary" type="button">Retry</button>
				</div>
			</div>
		</AuditPlate>
	);
}
