import {
	ArchiveIcon,
	CheckIcon,
	ChevronIcon,
	DocumentIcon,
	LoaderIcon,
	MessageIcon,
	PlusIcon,
	SearchIcon,
} from "@chopin/icons";

import { DecisionCard, PlanStatus, SendAction, SidecarCard } from "@chopin/editor";
import { Transcript } from "../chat/transcript";
import { TerminalAlert } from "../terminal-alert";
import { AuditPlate, StateLabel } from "./frame";

import type { Chat } from "@chopin/protocol";

let CHAT_ENTRIES: Chat.Entry[] = [
	{
		author: { kind: "member", handle: "maggieappleton" },
		id: "audit-member",
		text: "Can you make the empty state clearer?",
		ts: 1_787_913_600,
	},
	{
		author: { kind: "agent" },
		id: "audit-planner",
		text: "I’ll compare the existing states and propose a smaller, consistent pattern.",
		tools: [
			{ id: "audit-tool-1", name: "read_plan", status: "done", took: 420 },
			{ id: "audit-tool-2", name: "update_plan", status: "done", took: 180 },
		],
		ts: 1_787_913_660,
	},
];

function DialogSpecimens() {
	return (
		<AuditPlate
			description="The shared shell shown with ordinary, destructive, busy, and error content."
			item="dialogs"
			title="Dialogs"
		>
			<div className="design-audit-dialog-grid">
				<div>
					<StateLabel>Open</StateLabel>
					<div
						aria-labelledby="audit-rename-title"
						aria-modal="true"
						className="design-audit-dialog"
						role="dialog"
					>
						<h4 id="audit-rename-title">Rename document</h4>
						<label>
							Document name<input defaultValue="Design system audit" />
						</label>
						<div className="design-audit-dialog-actions">
							<button className="btn btn-md btn-secondary" type="button">Cancel</button>
							<button className="btn btn-md btn-primary" type="button">Save</button>
						</div>
					</div>
				</div>
				<div>
					<StateLabel>Destructive + error</StateLabel>
					<div
						aria-labelledby="audit-delete-title"
						aria-modal="true"
						className="design-audit-dialog"
						role="dialog"
					>
						<h4 id="audit-delete-title">Delete document permanently?</h4>
						<p>
							<strong>Design system audit</strong>{" "}
							will be permanently deleted. This cannot be undone.
						</p>
						<TerminalAlert>Could not delete the document.</TerminalAlert>
						<div className="design-audit-dialog-actions">
							<button className="btn btn-md btn-secondary" type="button">Cancel</button>
							<button className="btn btn-md btn-destructive" type="button">
								Delete permanently
							</button>
						</div>
					</div>
				</div>
				<div>
					<StateLabel>Busy</StateLabel>
					<div
						aria-busy="true"
						aria-labelledby="audit-busy-title"
						aria-modal="true"
						className="design-audit-dialog"
						role="dialog"
					>
						<h4 id="audit-busy-title">Rename document</h4>
						<label>
							Document name<input defaultValue="Design system audit" disabled />
						</label>
						<div className="design-audit-dialog-actions">
							<button className="btn btn-md btn-secondary" disabled type="button">Cancel</button>
							<button className="btn btn-md btn-primary" disabled type="button">
								<LoaderIcon aria-hidden="true" />Saving
							</button>
						</div>
					</div>
				</div>
			</div>
		</AuditPlate>
	);
}

function Lists() {
	return (
		<AuditPlate
			description="Rows share one inset, target height, and selected treatment."
			item="lists"
			title="Lists"
		>
			<div className="design-audit-surface-list" role="listbox" aria-label="Documents">
				<div role="option" aria-selected="false">
					<DocumentIcon size={14} />Design notes
				</div>
				<div role="option" aria-selected="true">
					<DocumentIcon size={14} />Design system audit<CheckIcon size={14} />
				</div>
				<div role="option" aria-selected="false" data-audit-state="hover">
					<DocumentIcon size={14} />Editor architecture
				</div>
			</div>
			<div className="design-audit-empty-row">
				<SearchIcon size={14} />
				<span>No matching documents</span>
			</div>
		</AuditPlate>
	);
}

function Navigation() {
	return (
		<AuditPlate
			description="Current, ancestor, archived, and loading rows in one compact rail."
			item="navigation"
			title="Navigation"
		>
			<nav aria-label="Audit navigation" className="design-audit-sidebar">
				<div className="design-audit-sidebar-heading">
					<span>Chopin</span>
					<button aria-label="Add document" className="btn btn-icon btn-ghost" type="button">
						<PlusIcon size={14} />
					</button>
				</div>
				<a href="#surfaces">
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
			<nav
				aria-label="Compact workspace view"
				className="workspace-navigation design-audit-compact-navigation"
			>
				<button className="btn btn-md btn-ghost min-h-11" type="button">Conversation</button>
				<button className="btn btn-md btn-ghost min-h-11" type="button">Document</button>
				<button aria-current="page" className="btn btn-md btn-ghost min-h-11" type="button">
					Decisions
				</button>
				<button className="btn btn-md btn-ghost min-h-11" type="button">Background</button>
			</nav>
		</AuditPlate>
	);
}

function Conversation() {
	return (
		<AuditPlate
			description="Member, Planner, tool activity, queued work, composer, and error states."
			item="chat"
			title="Conversation"
		>
			<div className="design-audit-chat">
				<Transcript
					active
					entries={CHAT_ENTRIES}
					handle="maggieappleton"
					onWithdraw={() => {}}
					queued={[{
						id: "audit-queued",
						handle: "maggieappleton",
						text: "Also check the compact layout.",
					}]}
				/>
				<div className="chat-composer px-2.5 pb-2.5">
					<div className="field flex flex-col">
						<textarea aria-label="Message" defaultValue="@chopin Review the spacing" rows={2} />
						<div className="design-audit-composer-actions">
							<span>Use # to reference a document</span>
							<SendAction label="Send message" onClick={() => {}} />
						</div>
					</div>
					<TerminalAlert className="design-audit-chat-error">
						Message could not be sent. Try again.
					</TerminalAlert>
				</div>
			</div>
		</AuditPlate>
	);
}

function Decisions() {
	return (
		<>
			<AuditPlate
				description="Outstanding, answered, resolved, orphaned, and deliberately empty records."
				item="decisions"
				title="Decisions"
			>
				<div className="design-audit-card-grid">
					<SidecarCard label="Decision">
						<strong>Which density should the navigation use?</strong>
						<div className="design-audit-choice-stack">
							<button className="btn btn-md btn-secondary" type="button">Compact</button>
							<button className="btn btn-md btn-secondary" type="button">Comfortable</button>
						</div>
					</SidecarCard>
					<DecisionCard
						value={{
							at: "2026-08-28T10:00:00.000Z",
							by: "maggieappleton",
							id: "audit-decision",
							notes: [{
								by: "maggieappleton",
								text: "Use compact rows, with comfortable section spacing.",
							}],
							quote: "Navigation density",
						}}
					/>
				</div>
				<button
					aria-expanded="true"
					className="btn btn-sm btn-ghost design-audit-resolved-toggle"
					type="button"
				>
					<ChevronIcon className="rotate-90" size={14} />
					<span>3</span>
					<span>resolved</span>
				</button>
			</AuditPlate>
			<AuditPlate
				description="Resolved discussion records retain empty and orphaned relationship states."
				item="resolved-comments"
				title="Resolved comments"
			>
				<div className="design-audit-card-grid">
					<SidecarCard label="Comment" settled status={<span>Accepted by @maggieappleton</span>}>
						<blockquote>Give controls a little more room.</blockquote>
						<p>Raised the shared horizontal inset.</p>
					</SidecarCard>
					<SidecarCard label="Comment" settled status={<span>Resolved</span>}>
						<p className="design-audit-muted">No prose was linked intentionally.</p>
					</SidecarCard>
					<SidecarCard label="Comment" settled status={<span>Orphaned</span>}>
						<p className="design-audit-muted">
							The original passage can no longer be located safely.
						</p>
					</SidecarCard>
				</div>
			</AuditPlate>
		</>
	);
}

function IdentityAndCollaboration() {
	return (
		<AuditPlate
			description="Loading identity and shared editing indicators shown in their product contexts."
			item="identity"
			title="Identity and collaboration"
		>
			<div className="design-audit-identity-grid">
				<div>
					<StateLabel>Avatar image loading</StateLabel>
					<div className="design-audit-identity-row">
						<img
							alt=""
							className="design-audit-avatar-loading"
							src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E"
						/>
						<div>
							<strong>Maggie Appleton</strong>
							<span>Joining the document…</span>
						</div>
					</div>
				</div>
				<div>
					<StateLabel>Editing this question</StateLabel>
					<div className="design-audit-question-context">
						<header>
							<strong>Rollout</strong>
							<span aria-label="Editing this question" className="design-audit-collaborator-badges">
								<span>@maggieappleton</span>
								<span>@olivia</span>
							</span>
						</header>
						<p>How should we introduce the new document workflow?</p>
					</div>
				</div>
			</div>
		</AuditPlate>
	);
}

function Feedback() {
	return (
		<>
			<AuditPlate
				description="Document-level asynchronous status from quiet through terminal."
				item="loading"
				title="Loading and status"
			>
				<div className="design-audit-status-grid">
					<div>
						<StateLabel>Loading</StateLabel>
						<PlanStatus synced={false} />
					</div>
					<div>
						<StateLabel>Busy</StateLabel>
						<PlanStatus busy synced />
					</div>
					<div>
						<StateLabel>Reconnect</StateLabel>
						<PlanStatus connection="reconnecting" synced />
					</div>
					<div>
						<StateLabel>Error</StateLabel>
						<PlanStatus failed="Permission denied" synced={false} />
					</div>
				</div>
			</AuditPlate>
			<AuditPlate
				description="First-use, no-results, and unavailable states provide a next step."
				item="empty"
				title="Empty states"
			>
				<div className="design-audit-empty-grid">
					<div>
						<DocumentIcon size={24} />
						<strong>No documents yet</strong>
						<span>Create the first shared document for this project.</span>
						<button className="btn btn-md btn-primary" type="button">Create document</button>
					</div>
					<div>
						<SearchIcon size={24} />
						<strong>No results</strong>
						<span>Try a shorter search or clear the filters.</span>
						<button className="btn btn-md btn-secondary" type="button">Clear search</button>
					</div>
					<div>
						<MessageIcon size={24} />
						<strong>Conversation unavailable</strong>
						<span>Reconnect to keep collaborating.</span>
						<button className="btn btn-md btn-secondary" type="button">Try again</button>
					</div>
				</div>
			</AuditPlate>
			<AuditPlate
				description="Inline, terminal, and recoverable failures use one destructive ink role."
				item="errors"
				title="Errors"
			>
				<div className="design-audit-error-stack">
					<TerminalAlert>Enter a document name.</TerminalAlert>
					<TerminalAlert>Could not open this document. Reloading may help.</TerminalAlert>
					<div className="design-audit-recoverable-error">
						<TerminalAlert>Research stopped before it finished.</TerminalAlert>
						<button className="btn btn-sm btn-secondary" type="button">Retry</button>
					</div>
				</div>
			</AuditPlate>
		</>
	);
}

export function Surfaces() {
	return (
		<>
			<DialogSpecimens />
			<Lists />
			<Navigation />
			<Conversation />
			<IdentityAndCollaboration />
			<Decisions />
			<Feedback />
		</>
	);
}
