import { boundedChatError } from "../../chat/references";
import { TerminalAlert } from "../../terminal-alert";
import { AuditPlate } from "../frame";
import { ComposerSpecimen } from "./conversation";

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
				<div className="workspace-root bg-chat-pane">
					<ComposerSpecimen
						notice={{
							tone: "error",
							text: boundedChatError(undefined),
							action: { label: "Retry", onClick: () => {} },
						}}
						text="Can we tighten the header?"
					/>
				</div>
			</div>
		</AuditPlate>
	);
}
