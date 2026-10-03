import { useState } from "react";

export function ResolvedActions(
	{ className, disabled, onDiscard, onReopen, submitting }: {
		className?: string;
		disabled: boolean;
		onDiscard?: () => void;
		onReopen?: () => void;
		submitting: boolean;
	},
) {
	let [confirming, setConfirming] = useState(false);
	let keep = () => setConfirming(false);
	let beginResolvedDiscard = () => setConfirming(true);
	let confirmResolvedDiscard = () => onDiscard?.();
	if (!onDiscard && !onReopen) return null;

	return (
		<footer
			className={className
				?? "question-actions flex flex-wrap items-center justify-end gap-2 px-4 pt-3"}
		>
			{onDiscard && confirming
				? (
					<>
						<p className="m-0 mr-auto text-sm text-text-secondary">Discard this decision?</p>
						<button
							className="btn btn-sm btn-secondary"
							data-resolved-action="keep"
							disabled={submitting}
							onClick={keep}
							type="button"
						>
							Keep it
						</button>
						<button
							className="btn btn-sm btn-destructive"
							data-resolved-action="confirm-discard"
							disabled={disabled || submitting}
							onClick={confirmResolvedDiscard}
							type="button"
						>
							{submitting ? "Discarding…" : "Discard decision"}
						</button>
					</>
				)
				: (
					<>
						{onDiscard && (
							<button
								className="btn btn-sm btn-secondary"
								data-resolved-action="discard"
								disabled={disabled || submitting}
								onClick={beginResolvedDiscard}
								type="button"
							>
								Discard
							</button>
						)}
						{onReopen && (
							<button
								className="btn btn-sm btn-primary"
								data-resolved-action="reopen"
								disabled={disabled || submitting}
								onClick={onReopen}
								type="button"
							>
								{submitting ? "Reopening…" : "Reopen"}
							</button>
						)}
					</>
				)}
		</footer>
	);
}
