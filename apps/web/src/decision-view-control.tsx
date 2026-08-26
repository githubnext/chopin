import { Count } from "@chopin/editor";

import type { DecisionView } from "@chopin/editor";

import { motionContract } from "./motion-contract";

export function decisionAttention(previous: number, current: number): boolean {
	return current > previous;
}

export function DecisionViewControl(
	{ attention, backgroundWork = 0, backgroundWorkEnabled = true, onView, unanswered, view }: {
		attention?: boolean;
		backgroundWork?: number;
		backgroundWorkEnabled?: boolean;
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
				}`}
				data-attention={attention || undefined}
				onClick={() => onView("decisions")}
				type="button"
			>
				Decisions
				{unanswered > 0 && (
					<span
						aria-hidden="true"
						className={`ml-1 ${attention ? motionContract("feedback").className : ""}`}
						data-motion-feedback={attention ? "count" : undefined}
						data-plan-decision-count
					>
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
			{backgroundWorkEnabled && (
				<button
					aria-current={view === "background-work" ? "page" : undefined}
					aria-label={backgroundWork > 0
						? `Background Work, ${backgroundWork} current`
						: "Background Work"}
					aria-pressed={view === "background-work"}
					className={`background-work-tab btn h-[26px] rounded-md px-2.5 text-[14px] ${
						view === "background-work"
							? "bg-ground font-medium text-gray-800"
							: "text-text-tertiary hover:bg-hover"
					}`}
					onClick={() => onView("background-work")}
					type="button"
				>
					Background Work
					{backgroundWork > 0 && (
						<span aria-hidden="true" className="ml-1">
							<Count>{backgroundWork}</Count>
						</span>
					)}
				</button>
			)}
		</div>
	);
}
