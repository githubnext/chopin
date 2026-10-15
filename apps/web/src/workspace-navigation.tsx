/** The compact workspace's row of destinations, above the single visible pane. */

import { Count } from "@chopin/editor/count";

import { DocumentActivityDot, documentActivityLabel } from "./document-activity";

import type { ReactNode } from "react";
import type { DocumentActivity } from "./document-activity";
import type { WorkspaceDestination, WorkspaceDocumentView } from "./workspace-model";

export type ChatActivity = { unread: number; busy: boolean };

export function destinationLabel(
	destination: WorkspaceDestination,
	unanswered: number,
	activity: ChatActivity,
	document: DocumentActivity,
): string {
	if (destination === "build") return "Build";
	if (destination === "plan") return documentActivityLabel(document);
	if (destination === "decisions" && unanswered > 0) {
		return `Decisions, ${unanswered} unanswered`;
	}
	if (destination === "chat" && activity.busy && activity.unread > 0) {
		return `Chat, Planner working, ${activity.unread} unread`;
	}
	if (destination === "chat" && activity.busy) return "Chat, Planner working";
	if (destination === "chat" && activity.unread > 0) {
		return `Chat, ${activity.unread} unread`;
	}
	return destination === "chat" ? "Chat" : destination === "decisions"
		? "Decisions"
		: "Document";
}

export function WorkspaceViewNavigation(
	{
		buildEnabled,
		buildGlyph,
		buildHot,
		buildReason,
		buildUnavailable,
		chatActivity,
		chatVisible,
		destinations,
		documentActivity,
		implementation,
		onBuildHover,
		onNavigate,
		unanswered,
		view,
	}: {
		buildEnabled: boolean;
		buildGlyph?: ReactNode;
		buildHot?: boolean;
		/** The id of the description read while Build cannot open. */
		buildReason: string;
		buildUnavailable: string;
		chatActivity: ChatActivity;
		chatVisible: boolean;
		destinations: WorkspaceDestination[];
		documentActivity?: DocumentActivity;
		implementation: boolean;
		onBuildHover?: (on: boolean) => void;
		onNavigate: (destination: WorkspaceDestination, source: HTMLElement) => void;
		unanswered: number;
		view: WorkspaceDocumentView;
	},
) {
	return (
		<nav
			aria-label="Workspace view"
			className={`workspace-navigation hairline-b grid shrink-0 bg-ground p-1 ${
				implementation ? "grid-cols-4" : "grid-cols-3"
			}`}
		>
			{destinations.map(destination => {
				let active = destination === "chat"
					? chatVisible
					: !chatVisible && view === destination;
				let label = destinationLabel(
					destination,
					unanswered,
					chatActivity,
					active ? undefined : documentActivity,
				);
				let unavailable = destination === "build" && !buildEnabled;
				let linked = destination === "build" && !unavailable;
				return (
					<button
						aria-current={active ? "page" : undefined}
						aria-describedby={unavailable ? buildReason : undefined}
						aria-disabled={unavailable || undefined}
						aria-label={label}
						aria-pressed={active}
						className={`btn btn-md btn-ghost min-h-11 min-w-0 ${
							unavailable ? "cursor-default opacity-40" : ""
						} ${destination === "build" ? "build-tab gap-1" : ""}`}
						data-hot={linked && buildHot || undefined}
						key={destination}
						onClick={event => {
							if (!unavailable) onNavigate(destination, event.currentTarget);
						}}
						onPointerEnter={linked ? () => onBuildHover?.(true) : undefined}
						onPointerLeave={linked ? () => onBuildHover?.(false) : undefined}
						type="button"
					>
						{destination === "chat"
							? "Chat"
							: destination === "build"
							? "Build"
							: destination === "decisions"
							? "Decisions"
							: "Document"}
						{destination === "plan" && !active && (
							<DocumentActivityDot activity={documentActivity} />
						)}
						{linked && buildGlyph && (
							<span className="build-tab-glyph" data-build-tab-glyph="">{buildGlyph}</span>
						)}
						{destination === "decisions" && unanswered > 0 && (
							<span aria-hidden="true" className="ml-1" data-plan-decision-count>
								<Count motion>{unanswered}</Count>
							</span>
						)}
						{destination === "chat" && chatActivity.busy && (
							<span aria-hidden="true" className="workspace-working-indicator ml-1 shrink-0" />
						)}
						{destination === "chat" && chatActivity.unread > 0 && (
							<span aria-hidden="true" className="ml-1">
								<Count motion>{chatActivity.unread}</Count>
							</span>
						)}
					</button>
				);
			})}
			{implementation && !buildEnabled && (
				<span className="sr-only" id={buildReason}>{buildUnavailable}</span>
			)}
		</nav>
	);
}
