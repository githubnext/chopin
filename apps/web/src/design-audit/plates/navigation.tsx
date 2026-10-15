import { useId } from "react";

import { BuildGlyph } from "../../build-plan-button";
import { BUILD_UNAVAILABLE } from "../../decision-view-control";
import { workspaceDestinations } from "../../workspace-model";
import { WorkspaceViewNavigation } from "../../workspace-navigation";
import { AuditPlate, StateLabel } from "../frame";
import { auditChannel, auditProject, AuditSidebarProject } from "./document-fixtures";

import type { ComponentProps } from "react";

const DOCUMENTS = [
	auditChannel("product-direction", "Product direction", {
		description: "Where the collaborative editor goes next",
		unansweredDecisions: 3,
	}),
	auditChannel("design-system-audit", "Design system audit"),
	auditChannel("typography-research", "Typography research", {
		parentChannelId: "design-system-audit",
	}),
	auditChannel("editor-architecture", "Editor architecture"),
];

// The sidebar Project in the states the live rail gives it.
const SIDEBAR_SPECIMENS: { label: string; project: ComponentProps<typeof AuditSidebarProject> }[] =
	[
		{
			label: "Current document, unanswered decisions",
			project: {
				currentDocumentId: "design-system-audit",
				entry: auditProject({ channels: DOCUMENTS, status: "ready", unansweredDecisions: 3 }),
			},
		},
		{
			label: "Current child, ancestor highlighted",
			project: {
				currentDocumentId: "typography-research",
				entry: auditProject({ channels: DOCUMENTS, status: "ready", unansweredDecisions: 3 }),
			},
		},
		{ label: "Loading", project: { entry: auditProject({ channels: [], status: "loading" }) } },
		{ label: "Empty", project: { entry: auditProject({ channels: [], status: "ready" }) } },
	];

type CompactState = Partial<ComponentProps<typeof WorkspaceViewNavigation>>;

// The compact workspace's destinations, in the states the live app gives them.
let COMPACT_SPECIMENS: { label: string; state: CompactState }[] = [
	{
		label: "Chat current, Planner working with 2 unread",
		state: { chatActivity: { busy: true, unread: 2 }, chatVisible: true },
	},
	{ label: "Document current", state: { unanswered: 3 } },
	{
		label: "Decisions current, new document changes",
		state: { documentActivity: "unseen", unanswered: 3, view: "decisions" },
	},
	{ label: "Build current, building", state: { view: "build" } },
	{ label: "Build not ready", state: { buildEnabled: false } },
];

export function NavigationPlate() {
	let reason = useId();
	return (
		<AuditPlate
			description="The live sidebar Project with current, ancestor, unanswered, loading, and empty rows. Descriptions appear on hover or focus. Below, the compact workspace's view navigation."
			item="navigation"
			title="Navigation"
		>
			<div className="design-audit-sidebar-specimens">
				{SIDEBAR_SPECIMENS.map(({ label, project }) => (
					<div key={label}>
						<StateLabel>{label}</StateLabel>
						<AuditSidebarProject
							archiveMode={project.archiveMode}
							currentDocumentId={project.currentDocumentId}
							entry={project.entry}
						/>
					</div>
				))}
			</div>
			<div className="design-audit-compact-navigation">
				{COMPACT_SPECIMENS.map(({ label, state }, index) => (
					<div key={label}>
						<StateLabel>{label}</StateLabel>
						<WorkspaceViewNavigation
							buildEnabled={state.buildEnabled ?? true}
							buildGlyph={<BuildGlyph look={{ done: 2, kind: "building", total: 5 }} />}
							buildReason={`${reason}-${index}`}
							buildUnavailable={BUILD_UNAVAILABLE}
							chatActivity={state.chatActivity ?? { busy: false, unread: 0 }}
							chatVisible={state.chatVisible ?? false}
							destinations={workspaceDestinations(true)}
							documentActivity={state.documentActivity}
							implementation
							onNavigate={() => {}}
							unanswered={state.unanswered ?? 0}
							view={state.view ?? "plan"}
						/>
					</div>
				))}
			</div>
		</AuditPlate>
	);
}
