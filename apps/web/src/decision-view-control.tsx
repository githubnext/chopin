import { Count } from "@chopin/editor";

import { DocumentActivityDot, documentActivityLabel } from "./document-activity";

import type { DecisionView } from "@chopin/editor";
import type { DocumentActivity } from "./document-activity";

export function decisionAttention(previous: number, current: number): boolean {
	return current > previous;
}

export function DecisionViewControl(
	{
		attention,
		documentActivity,
		onView,
		unanswered,
		view,
	}: {
		attention?: boolean;
		documentActivity?: DocumentActivity;
		onView: (view: DecisionView) => void;
		unanswered: number;
		view: DecisionView;
	},
) {
	return (
		<div
			aria-label="Document view"
			className="flex shrink-0 items-center gap-1.5"
			data-document-view-control
			role="group"
		>
			<button
				aria-current={view === "plan" ? "page" : undefined}
				aria-label={view === "plan" ? undefined : documentActivityLabel(documentActivity)}
				aria-pressed={view === "plan"}
				className={`btn btn-sm relative transition-[background-color,box-shadow,color] ${
					view === "plan"
						? "bg-ground font-medium text-gray-800"
						: "text-text-tertiary hover:bg-hover"
				}`}
				onClick={() => onView("plan")}
				type="button"
			>
				Document
				{view !== "plan" && <DocumentActivityDot activity={documentActivity} placement="corner" />}
			</button>
			<button
				aria-current={view === "decisions" ? "page" : undefined}
				aria-label={unanswered > 0 ? `Decisions, ${unanswered} unanswered` : "Decisions"}
				aria-pressed={view === "decisions"}
				className={`btn btn-sm gap-1 transition-[background-color,box-shadow,color] ${
					view === "decisions"
						? "bg-ground font-medium text-gray-800"
						: "text-text-tertiary hover:bg-hover"
				}`}
				data-attention={attention || undefined}
				onClick={() => onView("decisions")}
				type="button"
			>
				Decisions
				{unanswered > 0 && (
					<span
						aria-hidden="true"
						data-plan-decision-count
					>
						<Count
							appearance="quiet"
							key={attention ? `attention-${unanswered}` : "settled"}
							motion={attention}
						>
							{unanswered}
						</Count>
					</span>
				)}
			</button>
		</div>
	);
}
