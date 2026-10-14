import { CheckIcon, ClockIcon, SparkleIcon, WarningIcon } from "@chopin/icons";
import type { Followthrough } from "@chopin/protocol";

const WAITING = new Map<string, string>([
	["owner-unavailable", "Waiting for the Planner"],
	["remote-unavailable", "Waiting for a connected Planner"],
	["document-locked", "Waiting for the build to finish"],
	["planner-busy", "Waiting for the current turn"],
]);

export function followthroughLabel(view: Followthrough.View): string {
	if (view.status === "pending") {
		return WAITING.get(view.reason ?? "") ?? "Waiting to review findings";
	}
	if (view.status === "running") return "Reviewing findings";
	if (view.status === "done") return "Findings reviewed";
	if (view.status === "failed") {
		return view.reason === "interrupted" ? "Review interrupted" : "Review failed";
	}
	return view.reason === "dismissed" ? "Review dismissed" : "No longer relevant";
}

/** Kept above the report's open surface so recovery controls remain independent actions. */
export function FollowthroughStatus(
	{ view, busy, canEdit = false, onRetry, onDismiss }: {
		view: Followthrough.View;
		busy?: boolean;
		canEdit?: boolean;
		onRetry?: () => void;
		onDismiss?: () => void;
	},
) {
	let failed = view.status === "failed";
	let Icon = failed ? WarningIcon : view.status === "done"
		? CheckIcon
		: view.status === "running"
		? SparkleIcon
		: ClockIcon;
	return (
		<div className="plan-followthrough" data-followthrough-status={view.status}>
			<span className="flex min-w-0 items-center gap-1.5" role="status">
				<Icon aria-hidden="true" className="shrink-0" size={12} />
				{followthroughLabel(view)}
			</span>
			{canEdit && failed && onRetry && (
				<button
					className="btn btn-compact btn-outline"
					disabled={busy}
					onClick={onRetry}
					type="button"
				>
					Retry review
				</button>
			)}
			{canEdit && (failed || view.status === "pending") && onDismiss && (
				<button
					className="btn btn-compact btn-ghost"
					disabled={busy}
					onClick={onDismiss}
					type="button"
				>
					Dismiss review
				</button>
			)}
		</div>
	);
}
