import { Count } from "@chopin/editor";
import { useEffect, useRef, useState } from "react";

import { DocumentActivityDot, documentActivityLabel } from "./document-activity";

import type { WorkspaceDocumentView } from "./workspace-model";
import type { DocumentActivity } from "./document-activity";

export function decisionAttention(previous: number, current: number): boolean {
	return current > previous;
}

export function useDecisionAttention(unanswered: number): boolean {
	let previous = useRef(unanswered);
	let [attention, setAttention] = useState(false);
	useEffect(() => {
		let prior = previous.current;
		previous.current = unanswered;
		if (!decisionAttention(prior, unanswered)) return;
		setAttention(true);
		let timer = window.setTimeout(() => setAttention(false), 200);
		return () => window.clearTimeout(timer);
	}, [unanswered]);
	return attention;
}

export function unansweredDecisionsLabel(label: string, unanswered: number): string {
	if (unanswered <= 0) return label;
	return `${label}, ${unanswered} unanswered ${unanswered === 1 ? "decision" : "decisions"}`;
}

export function DecisionViewControl(
	{
		attention,
		buildEnabled,
		documentActivity,
		onView,
		unanswered,
		view,
	}: {
		attention?: boolean;
		buildEnabled?: boolean;
		documentActivity?: DocumentActivity;
		onView: (view: WorkspaceDocumentView) => void;
		unanswered: number;
		view: WorkspaceDocumentView;
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
					unanswered > 0 ? "btn-with-count" : ""
				} ${
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
						className="flex"
						data-plan-decision-count
					>
						<Count
							appearance="control"
							key={attention ? `attention-${unanswered}` : "settled"}
							motion={attention}
							selected={view === "decisions"}
						>
							{unanswered}
						</Count>
					</span>
				)}
			</button>
			{buildEnabled !== undefined && (
				<button
					aria-current={view === "build" ? "page" : undefined}
					aria-pressed={view === "build"}
					className={`btn btn-sm transition-[background-color,box-shadow,color] ${
						view === "build"
							? "bg-ground font-medium text-gray-800"
							: "text-text-tertiary hover:bg-hover"
					}`}
					disabled={!buildEnabled}
					onClick={() => onView("build")}
					type="button"
				>
					Build
				</button>
			)}
		</div>
	);
}
