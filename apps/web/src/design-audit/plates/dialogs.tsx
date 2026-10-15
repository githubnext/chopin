import { LoaderIcon } from "@chopin/icons";

import { TerminalAlert } from "../../terminal-alert";
import { AuditPlate, StateLabel } from "../frame";

export function DialogsPlate() {
	return (
		<AuditPlate
			description="Inline visual examples of ordinary, destructive, busy, and error dialog content."
			item="dialogs"
			title="Dialogs"
		>
			<div className="design-audit-dialog-grid">
				<div>
					<StateLabel>Open</StateLabel>
					<div
						aria-labelledby="audit-rename-title"
						className="design-audit-dialog"
						role="group"
					>
						<h4 id="audit-rename-title">Rename document</h4>
						<label>
							Document name<input defaultValue="Design system audit" />
						</label>
						<div className="design-audit-dialog-actions">
							<button className="btn btn-md btn-secondary" type="button">Cancel</button>
							<button className="btn btn-md btn-primary" type="button">Save</button>
						</div>
					</div>
				</div>
				<div>
					<StateLabel>Destructive + error</StateLabel>
					<div
						aria-labelledby="audit-delete-title"
						className="design-audit-dialog"
						role="group"
					>
						<h4 id="audit-delete-title">Delete document permanently?</h4>
						<p>
							<strong>Design system audit</strong>{" "}
							will be permanently deleted. This cannot be undone.
						</p>
						<TerminalAlert>Could not delete the document.</TerminalAlert>
						<div className="design-audit-dialog-actions">
							<button className="btn btn-md btn-secondary" type="button">Cancel</button>
							<button className="btn btn-md btn-destructive" type="button">
								Delete permanently
							</button>
						</div>
					</div>
				</div>
				<div>
					<StateLabel>Busy</StateLabel>
					<div
						aria-busy="true"
						aria-labelledby="audit-busy-title"
						className="design-audit-dialog"
						role="group"
					>
						<h4 id="audit-busy-title">Rename document</h4>
						<label>
							Document name<input defaultValue="Design system audit" disabled />
						</label>
						<div className="design-audit-dialog-actions">
							<button className="btn btn-md btn-secondary" disabled type="button">Cancel</button>
							<button aria-busy="true" className="btn btn-md btn-primary" disabled type="button">
								<LoaderIcon aria-hidden="true" data-button-loader="" />Saving
							</button>
						</div>
					</div>
				</div>
			</div>
		</AuditPlate>
	);
}
