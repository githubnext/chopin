/** Notices that sit beside PlanStatus in the document title bar. */

import type { Refusal } from "@chopin/editor";

export const LOST_EDITS =
	"Your last edits couldn't be saved because the document changed while you were offline.";

export const UNDO_REFUSALS: Record<Refusal, string> = {
	others: "Others have edited this since.",
	change: "This change can't be reversed here.",
};

export function LostEditsNotice({ onDismiss }: { onDismiss: () => void }) {
	return (
		<div className="plan-status" data-level="alert" role="alert">
			<span className="plan-status-text">
				<span
					aria-hidden="true"
					className="plan-status-label"
					data-tooltip={LOST_EDITS}
					data-tooltip-verbatim=""
				>
					Edits not saved
				</span>
				<span aria-hidden="true" className="plan-status-detail">{LOST_EDITS}</span>
				<span className="sr-only">{LOST_EDITS}</span>
			</span>
			<button
				className="btn btn-sm btn-ghost"
				onClick={onDismiss}
				type="button"
			>
				Dismiss
			</button>
		</div>
	);
}

/** Announced separately, by a live region that stays mounted. */
export function UndoRefusedNotice({ reason }: { reason: Refusal }) {
	return (
		<div className="plan-status" data-level="notice">
			<span aria-hidden="true" className="plan-status-dot" />
			<span aria-hidden="true" className="plan-status-text">
				<span
					className="plan-status-label"
					data-tooltip={UNDO_REFUSALS[reason]}
					data-tooltip-verbatim=""
				>
					Can't undo
				</span>
				<span className="plan-status-detail">
					{UNDO_REFUSALS[reason]}
				</span>
			</span>
		</div>
	);
}
