import { ResolvedComment } from "@chopin/editor";

import { AuditPlate, StateLabel } from "../frame";

import type { Comment } from "@chopin/protocol";
import type { ReactNode } from "react";

let THREAD: Comment.Thread = {
	id: "audit-resolved-thread",
	status: "resolved",
	quote: "Controls sit close to the edge of the panel.",
	resolver: "olivia",
	at: 1_787_913_900,
	notes: [
		{
			author: "member",
			handle: "maggieappleton",
			id: "audit-resolved-note-1",
			text: "Give controls a little more room.",
			to: "planner",
			ts: 1_787_913_600,
		},
		{
			author: "planner",
			id: "audit-resolved-note-2",
			text: "Raised the shared horizontal inset from 12px to 16px.",
			ts: 1_787_913_660,
		},
	],
};

function noop() {}

/**
 * The marker's popover surface, as `ResolvedLayer` places it beside the prose.
 * The slot only gives the absolutely positioned surface room in the plate.
 */
function Popover(
	{ children, label, pinned }: { children: ReactNode; label: string; pinned: boolean },
) {
	return (
		<div className="design-audit-resolved-sample">
			<StateLabel>{label}</StateLabel>
			<div className="design-audit-resolved-slot" data-pinned={pinned ? "" : undefined}>
				<div
					aria-label={pinned ? "Resolved comment" : undefined}
					className="plan-comment-preview plan-decision-pop motion-comment-preview is-open"
					data-kind="comment"
					data-motion-immediate=""
					data-pinned={pinned ? "" : undefined}
					role={pinned ? "dialog" : "tooltip"}
				>
					{children}
				</div>
			</div>
		</div>
	);
}

export function ResolvedCommentsPlate() {
	return (
		<AuditPlate
			description="A resolved comment's marker popover: hover preview, pinned with Reopen, and a failed reopen."
			item="resolved-comments"
			title="Resolved comments"
		>
			<div className="design-audit-resolved-grid">
				<Popover label="Hover preview" pinned={false}>
					<ResolvedComment pinned={false} thread={THREAD} />
				</Popover>
				<Popover label="Pinned" pinned>
					<ResolvedComment close={noop} onReopen={noop} pinned thread={THREAD} />
				</Popover>
				<Popover label="Reopen failed" pinned>
					<ResolvedComment
						close={noop}
						error="Couldn’t reopen the comment"
						onReopen={noop}
						pinned
						thread={THREAD}
					/>
				</Popover>
			</div>
		</AuditPlate>
	);
}
