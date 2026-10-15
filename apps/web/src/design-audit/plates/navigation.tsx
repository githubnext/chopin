import { ArchiveIcon, ChevronIcon, DocumentIcon, LoaderIcon, PlusIcon } from "@chopin/icons";

import { useId } from "react";

import { BuildGlyph } from "../../build-plan-button";
import { BUILD_UNAVAILABLE } from "../../decision-view-control";
import { workspaceDestinations } from "../../workspace-model";
import { WorkspaceViewNavigation } from "../../workspace-navigation";
import { AuditPlate, StateLabel } from "../frame";

import type { ComponentProps } from "react";

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
			description="Current, ancestor, archived, and loading rows in one compact rail. Descriptions appear on hover or focus. Below, the compact workspace's view navigation."
			item="navigation"
			title="Navigation"
		>
			<nav aria-label="Audit navigation" className="design-audit-sidebar" data-tooltip-edge="">
				<div className="design-audit-sidebar-heading">
					<span>Chopin</span>
					<button aria-label="Add document" className="btn btn-icon btn-ghost" type="button">
						<PlusIcon size={14} />
					</button>
				</div>
				<a
					aria-description="Where the collaborative editor goes next"
					data-tooltip="Where the collaborative editor goes next"
					data-tooltip-side="right"
					data-tooltip-verbatim=""
					href="#surfaces"
				>
					<DocumentIcon size={14} />Product direction
				</a>
				<a aria-current="page" href="#surfaces">
					<DocumentIcon size={14} />Design system audit
				</a>
				<a data-navigation-state="ancestor" href="#surfaces">
					<ChevronIcon size={14} />Research notes
				</a>
				<a data-navigation-state="archived" href="#surfaces">
					<ArchiveIcon size={14} />Archived draft
				</a>
				<div className="design-audit-navigation-loading">
					<LoaderIcon size={14} />Loading more…
				</div>
			</nav>
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
