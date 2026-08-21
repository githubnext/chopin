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
		<div
			aria-label="Document view"
			className="flex items-center gap-1.5"
			data-document-view-control
			role="group"
		>
			<button
				aria-current={view === "plan" ? "page" : undefined}
				aria-pressed={view === "plan"}
				className={`btn h-[26px] rounded-md px-2.5 text-[14px] transition-[background-color,box-shadow,color] ${
					view === "plan"
						? "bg-ground font-medium text-gray-800"
						: "text-text-tertiary hover:bg-hover"
				}`}
				onClick={() => onView("plan")}
				type="button"
			>
				Document
			</button>
			<button
				aria-current={view === "decisions" ? "page" : undefined}
				aria-label={unanswered > 0 ? `Decisions, ${unanswered} unanswered` : "Decisions"}
				aria-pressed={view === "decisions"}
				className={`btn h-[26px] rounded-md px-2.5 text-[14px] transition-[background-color,box-shadow,color] ${
					view === "decisions"
						? "bg-ground font-medium text-gray-800"
						: "text-text-tertiary hover:bg-hover"
				} ${attention ? "animate-enter" : ""}`}
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
			<button
				className="task-progress-tab btn h-[26px] rounded-md px-2.5 text-[14px] text-text-tertiary opacity-50"
				disabled
				type="button"
			>
				Tasks &amp; Progress
			</button>
		</div>
	);
}
