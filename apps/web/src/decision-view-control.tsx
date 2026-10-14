import { Count } from "@chopin/editor/count";
import { useEffect, useId, useRef, useState } from "react";

import { DocumentActivityDot, documentActivityLabel } from "./document-activity";

import type { ReactNode } from "react";
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

/** Why Build cannot open yet, for its tooltip and accessible description. */
export const BUILD_UNAVAILABLE = "Build the plan to see its tasks";

export function DecisionViewControl(
	{
		attention,
		buildEnabled,
		buildGlyph,
		buildHot,
		documentActivity,
		onBuildHover,
		onView,
		unanswered,
		view,
	}: {
		attention?: boolean;
		/** Build opens once the plan has been built; `undefined` for a document without Build. */
		buildEnabled?: boolean;
		/** The build's status glyph, the twin of the header capsule's. */
		buildGlyph?: ReactNode;
		/** The header capsule is hovered. */
		buildHot?: boolean;
		documentActivity?: DocumentActivity;
		onBuildHover?: (on: boolean) => void;
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
				className={`btn btn-sm gap-1.5 transition-[background-color,box-shadow,color] ${
					view === "plan"
						? "bg-ground font-medium text-gray-800"
						: "text-text-tertiary hover:bg-hover"
				}`}
				onClick={() => onView("plan")}
				type="button"
			>
				Document
				{view !== "plan" && <DocumentActivityDot activity={documentActivity} />}
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
				<BuildSegment
					glyph={buildGlyph}
					hot={buildHot}
					onHover={onBuildHover}
					onView={onView}
					ready={buildEnabled}
					selected={view === "build"}
				/>
			)}
		</div>
	);
}

/**
 * Build stays focusable before the first build, so its reason can be read;
 * `disabled` would hide both the tooltip and the description. Opening it never
 * starts anything: only Build plan does.
 */
function BuildSegment(
	{ glyph, hot, onHover, onView, ready, selected }: {
		glyph?: ReactNode;
		hot?: boolean;
		onHover?: (on: boolean) => void;
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
				className={`build-tab btn btn-sm gap-1 transition-[background-color,box-shadow,color] ${
					selected
						? "bg-ground font-medium text-gray-800"
						: ready
						? "text-text-tertiary hover:bg-hover"
						: "cursor-default text-text-tertiary opacity-40"
				}`}
				data-hot={ready && hot || undefined}
				data-tooltip={ready ? undefined : BUILD_UNAVAILABLE}
				data-tooltip-detail={ready ? undefined : ""}
				onBlur={ready ? () => onHover?.(false) : undefined}
				onClick={() => {
					if (ready) onView("build");
				}}
				onFocus={ready ? () => onHover?.(true) : undefined}
				onPointerEnter={ready ? () => onHover?.(true) : undefined}
				onPointerLeave={ready ? () => onHover?.(false) : undefined}
				type="button"
			>
				Build
				{ready && glyph && <span className="build-tab-glyph" data-build-tab-glyph="">{glyph}</span>}
			</button>
			{!ready && <span className="sr-only" id={reason}>{BUILD_UNAVAILABLE}</span>}
		</>
	);
}
