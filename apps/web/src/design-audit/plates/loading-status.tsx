import { PlanStatus } from "@chopin/editor";
import { useId } from "react";

import { DecisionViewControl } from "../../decision-view-control";
import { DocumentTitleBar } from "../../document-title-bar";
import { LostEditsNotice, UndoRefusedNotice } from "../../document-status-notices";
import { ConnectionBannerView } from "../../chat/connection-banner";
import { connectionStep, INITIAL_MEMORY } from "../../chat/connection-phase";
import { SurfaceToggle } from "../../workspace";
import { AuditPlate, StateLabel } from "../frame";

import type { PlanStatusProps } from "@chopin/editor";
import type { ReactNode } from "react";

let STATUS_SPECIMENS: { label: string; notice?: ReactNode; status: PlanStatusProps }[] = [
	{ label: "Connected", status: { connection: "connected", synced: true } },
	{ label: "Loading", status: { synced: false } },
	{ label: "Busy", status: { busy: true, synced: true } },
	{ label: "Error", status: { failed: "Permission denied", synced: false } },
	{ label: "No access", status: { connection: "denied", synced: true } },
	{
		label: "Can't undo",
		notice: <UndoRefusedNotice reason="others" />,
		status: { connection: "connected", synced: true },
	},
	{
		label: "Edits not saved",
		notice: <LostEditsNotice onDismiss={() => {}} />,
		status: { connection: "connected", synced: true },
	},
];

let PAGE_NOTICES = [
	{ label: "Reconnecting", failures: 1 },
	{ label: "Dropped, after repeated failed reconnects", failures: 4 },
];

export function LoadingStatusPlate() {
	let chat = useId();
	return (
		<AuditPlate
			description="Document status sits at the end of the document title bar, silent while connected and idle. A lost connection is one banner, at the Chat composer or, where Chat is not on screen, the top of the document's content, after a short grace period."
			item="loading"
			title="Loading and status"
		>
			<div className="design-audit-status-grid">
				{STATUS_SPECIMENS.map(({ label, notice, status }) => (
					<div key={label}>
						<StateLabel>{label}</StateLabel>
						<div className="flex min-w-0 flex-col">
							<DocumentTitleBar
								controls={<DecisionViewControl onView={() => {}} unanswered={0} view="plan" />}
								status={
									<>
										{notice}
										<PlanStatus
											busy={status.busy}
											connection={status.connection}
											failed={status.failed}
											onReload={() => {}}
											synced={status.synced}
										/>
									</>
								}
								title={
									<span className="title-control min-w-0 truncate text-xs font-medium">
										Design system audit
									</span>
								}
								toggle={
									<SurfaceToggle
										activity={{ busy: false, unread: 0 }}
										controls={chat}
										expanded={false}
										onToggle={() => {}}
									/>
								}
							/>
						</div>
					</div>
				))}
				{PAGE_NOTICES.map(({ label, failures }) => (
					<div key={label}>
						<StateLabel>{label}</StateLabel>
						<div className="design-audit-page-notice">
							<ConnectionBannerView
								onRetry={failures >= 4 ? () => {} : undefined}
								view={connectionStep(INITIAL_MEMORY, {
									socket: "lost",
									failures,
									retrying: undefined,
									synced: true,
									current: true,
									turn: undefined,
									messages: 0,
									planner: undefined,
								}).view}
							/>
							<span className="design-audit-skeleton-line" />
							<span className="design-audit-skeleton-line" />
						</div>
					</div>
				))}
			</div>
		</AuditPlate>
	);
}
