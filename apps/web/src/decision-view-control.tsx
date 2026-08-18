import { Count } from "@chopin/editor";

import type { DecisionView } from "@chopin/editor";

export function decisionAttention(previous: number, current: number): boolean {
	return current > previous;
}

export function DecisionViewControl(
	{ attention, onView, unanswered, view }: {
		attention?: boolean;
		onView: (view: DecisionView) => void;
		unanswered: number;
		view: DecisionView;
	},
) {
	return (
		<div aria-label="Document view" className="flex items-center gap-1" role="group">
			<button
				aria-current={view === "plan" ? "page" : undefined}
				aria-pressed={view === "plan"}
				className="btn btn-sm btn-ghost"
				onClick={() => onView("plan")}
				type="button"
			>
				Plan
			</button>
			<button
				aria-current={view === "decisions" ? "page" : undefined}
				aria-label={unanswered > 0 ? `Decisions, ${unanswered} unanswered` : "Decisions"}
				aria-pressed={view === "decisions"}
				className={`btn btn-sm btn-ghost ${attention ? "animate-enter" : ""}`}
				data-attention={attention || undefined}
				onClick={() => onView("decisions")}
				type="button"
			>
				Decisions
				{unanswered > 0 && (
					<span aria-hidden="true" className="ml-1" data-plan-decision-count>
						<Count>{unanswered}</Count>
					</span>
				)}
			</button>
		</div>
	);
}
