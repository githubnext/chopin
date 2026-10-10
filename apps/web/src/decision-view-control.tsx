import { Count } from "@chopin/editor/count";
import { useId } from "react";

import { DocumentActivityDot, documentActivityLabel } from "./document-activity";

import type { WorkspaceDocumentView } from "./workspace-model";
import type { DocumentActivity } from "./document-activity";

/** Why Build cannot open yet, for its tooltip and accessible description. */
export const BUILD_UNAVAILABLE = "Write the document before building it";

export function DecisionViewControl(
	{
		attention,
		buildEnabled,
		hasGraph,
		documentActivity,
		onView,
		unanswered,
		view,
	}: {
		attention?: boolean;
		buildEnabled?: boolean;
		hasGraph?: boolean;
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
			{hasGraph && (
				<button
					aria-current={view === "graph" ? "page" : undefined}
					aria-pressed={view === "graph"}
					className={`btn btn-sm ${
						view === "graph"
							? "bg-ground font-medium text-gray-800"
							: "text-text-tertiary hover:bg-hover"
					}`}
					onClick={() => onView("graph")}
					type="button"
				>
					Task graph
				</button>
			)}
			{buildEnabled !== undefined && (
				<BuildSegment ready={buildEnabled} selected={view === "build"} onView={onView} />
			)}
		</div>
	);
}

/**
 * Build stays focusable while the document is empty, so its reason can be read;
 * `disabled` would hide both the tooltip and the description.
 */
function BuildSegment(
	{ onView, ready, selected }: {
		onView: (view: WorkspaceDocumentView) => void;
		ready: boolean;
		selected: boolean;
	},
) {
	let reason = useId();
	return (
		<>
			<button
				aria-current={selected ? "page" : undefined}
				aria-describedby={ready ? undefined : reason}
				aria-disabled={ready ? undefined : true}
				aria-pressed={selected}
				className={`btn btn-sm transition-[background-color,box-shadow,color] ${
					selected
						? "bg-ground font-medium text-gray-800"
						: ready
						? "text-text-tertiary hover:bg-hover"
						: "cursor-default text-text-tertiary opacity-40"
				}`}
				data-tooltip={ready ? undefined : BUILD_UNAVAILABLE}
				data-tooltip-detail={ready ? undefined : ""}
				onClick={() => {
					if (ready) onView("build");
				}}
				type="button"
			>
				Build
			</button>
			{!ready && <span className="sr-only" id={reason}>{BUILD_UNAVAILABLE}</span>}
		</>
	);
}
