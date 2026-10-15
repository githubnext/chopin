import { useState } from "react";

import { ChatComposer } from "../../chat/composer";
import { boundedChatError } from "../../chat/references";
import { Participation } from "../../chat/participation";
import { mentionCandidates } from "../../chat/mentions";
import { Transcript } from "../../chat/transcript";
import { AuditPlate, StateLabel } from "../frame";

import type { Chat } from "@chopin/protocol";
import type { ChatComposerProps } from "../../chat/composer";
import type { Wire } from "../../wire";

const HANDLE = "maggieappleton";

let CHAT_ENTRIES: Chat.Entry[] = [
	{
		author: { kind: "member", handle: HANDLE },
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

let MENTIONS = [
	HANDLE,
	...mentionCandidates({ authors: [], people: [], planner: true, self: HANDLE })
		.map(candidate => candidate.login),
];

/** Participation's toggle asks the wire; offline, the audit's press does nothing. */
let OFFLINE = { connected: false } as Wire;

type Specimen =
	& Pick<
		ChatComposerProps,
		"connectionLabel" | "notice" | "onReconnect" | "run" | "unavailable"
	>
	& { sending?: boolean; text?: string };

/** The live composer, holding its own draft so the specimen can be typed into. */
export function ComposerSpecimen(
	{ connectionLabel, notice, onReconnect, run, sending = false, text = "", unavailable }: Specimen,
) {
	let [draft, setDraft] = useState(text);
	let draftable = !unavailable;
	return (
		<ChatComposer
			agent
			connectionLabel={connectionLabel}
			draftable={draftable}
			notice={notice}
			onReconnect={onReconnect}
			onSubmit={() => {}}
			references={{ disabled: false, onMentionDocs: () => setDraft(value => `${value}#`) }}
			run={run}
			sendDisabled={!draftable || sending || !draft.trim()
				|| (!!connectionLabel && connectionLabel !== "Connecting…")}
			sending={sending}
			unavailable={unavailable}
			input={{
				"aria-expanded": false,
				mentions: MENTIONS,
				onChange: event => setDraft(event.currentTarget.value),
				onSelect: () => {},
				references: [],
				resetKey: 0,
				value: draft,
			}}
		/>
	);
}

export function ConversationPlate() {
	return (
		<AuditPlate
			description="Member, Planner, tool activity, queued work, composer, and error states."
			item="chat"
			title="Conversation"
		>
			<div className="workspace-root relative flex flex-col overflow-hidden bg-ground design-audit-chat-stage">
				<div className="workspace-chat-panel relative flex min-w-0 flex-col overflow-hidden bg-chat-pane">
					<div className="workspace-chat-body relative min-h-0 flex-1">
						<div className="flex h-full min-h-0 flex-col">
							<Participation
								disabled={false}
								state={{ enabled: true, paused: false }}
								wire={OFFLINE}
							/>
							<Transcript
								active
								entries={CHAT_ENTRIES}
								handle={HANDLE}
								onWithdraw={() => {}}
								queued={[{
									id: "audit-queued",
									handle: HANDLE,
									text: "Also check the compact layout.",
								}]}
							/>
							<ComposerSpecimen />
						</div>
					</div>
				</div>
			</div>
			<div className="workspace-root bg-chat-pane design-audit-composer-states">
				<div>
					<StateLabel>Mentioning Chopin</StateLabel>
					<ComposerSpecimen text="@chopin Review the spacing" />
				</div>
				<div>
					<StateLabel>Sending</StateLabel>
					<ComposerSpecimen sending text="Can we tighten the header?" />
				</div>
				<div>
					<StateLabel>Send failed</StateLabel>
					<ComposerSpecimen
						notice={{
							tone: "error",
							text: boundedChatError(undefined),
							action: { label: "Retry", onClick: () => {} },
						}}
						text="Can we tighten the header?"
					/>
				</div>
				<div>
					<StateLabel>Reconnecting</StateLabel>
					<ComposerSpecimen connectionLabel="Reconnecting…" />
				</div>
				<div>
					<StateLabel>Offline</StateLabel>
					<ComposerSpecimen connectionLabel="Offline" onReconnect={() => {}} />
				</div>
				<div>
					<StateLabel>Chopin working</StateLabel>
					<ComposerSpecimen run={{ action: "stop", disabled: false, onClick: () => {} }} />
				</div>
				<div>
					<StateLabel>Automatic replies paused</StateLabel>
					<Participation disabled={false} state={{ enabled: true, paused: true }} wire={OFFLINE} />
					<ComposerSpecimen />
				</div>
				<div>
					<StateLabel>Read-only</StateLabel>
					<ComposerSpecimen unavailable="readonly" />
				</div>
				<div>
					<StateLabel>Archived</StateLabel>
					<ComposerSpecimen unavailable="archived" />
				</div>
			</div>
		</AuditPlate>
	);
}
