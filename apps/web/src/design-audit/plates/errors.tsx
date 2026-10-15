import { boundedChatError } from "../../chat/references";
import { NavigationError } from "../../navigation-error";
import { TerminalAlert } from "../../terminal-alert";
import { AuditPlate } from "../frame";
import { ComposerSpecimen } from "./conversation";

export function ErrorsPlate() {
	return (
		<AuditPlate
			description="Inline and terminal failures use one destructive ink; a recoverable one is a notice with its retry."
			item="errors"
			title="Errors"
		>
			<div className="design-audit-error-stack">
				<TerminalAlert className="text-sm text-destructive-ink">
					Enter a document name.
				</TerminalAlert>
				<TerminalAlert className="text-sm text-destructive-ink">
					Could not open this document. Reloading may help.
				</TerminalAlert>
				<NavigationError message="Could not update navigation." onRetry={() => {}} />
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
