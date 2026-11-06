import { useState } from "react";

import { ChatComposer } from "../../chat/composer";
import { plannerGlyph, plannerPlacement, plannerStatus } from "../../chat/planner-status";
import { MachineGlyph, PlannerNote } from "../../machine-button";
import { boundedChatError } from "../../chat/references";
import { mentionCandidates } from "../../chat/mentions";
import { Transcript } from "../../chat/transcript";
import { AuditPlate, StateLabel } from "../frame";

import type { Chat, Session } from "@chopin/protocol";
import type { ChatComposerProps } from "../../chat/composer";

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

const STARTING: Session.PlannerAttachment = { state: "starting", login: "mona" };
const FAILING: Session.PlannerAttachment = {
	state: "starting",
	login: "mona",
	failure: {
		attempts: 3,
		reason: "The checkout's git config sets a credential helper",
		at: "2026-11-04T18:29:00.000Z",
	},
};

function status(planner: Session.PlannerAttachment) {
	return plannerStatus(planner, "Build box");
}

let MENTIONS = [
	HANDLE,
	...mentionCandidates({ authors: [], people: [], planner: true, self: HANDLE })
		.map(candidate => candidate.login),
];

type Specimen =
	& Pick<ChatComposerProps, "notice" | "run" | "unavailable">
	& { sending?: boolean; text?: string; chopin?: boolean };

/** The live composer, holding its own draft so the specimen can be typed into. */
export function ComposerSpecimen(
	{
		chopin = false,
		notice,
		run,
		sending = false,
		text = "",
		unavailable,
	}: Specimen,
) {
	let [draft, setDraft] = useState(text);
	let [mode, setMode] = useState(chopin);
	let draftable = !unavailable;
	return (
		<ChatComposer
			agent
			mode={{ chopin: mode, disabled: !draftable || sending, onToggle: () => setMode(on => !on) }}
			draftable={draftable}
			notice={notice}
			onSubmit={() => {}}
			references={{ disabled: false, onMentionDocs: () => setDraft(value => `${value}#`) }}
			run={run}
			sendDisabled={!draftable || sending || !draft.trim()}
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

/**
 * With no machine button to carry them, the composer's top edge tells each state, and draws the
 * reason for a machine that cannot be connected to.
 */
let WITHOUT_BUTTON = [
	{ label: "No machine button: connecting", planner: STARTING },
	{ label: "No machine button: can't connect, reason drawn", planner: FAILING },
	{
		label: "No machine button: offline",
		planner: { state: "disconnected", login: "mona" },
	},
	{
		label: "No machine button: stepped away",
		planner: { state: "held", login: "mona", until: "2026-11-04T18:31:00.000Z" },
	},
	{ label: "No machine button: no machine connected", planner: { state: "none" } },
] as const satisfies readonly { label: string; planner: Session.PlannerAttachment }[];

/**
 * The machine button's dot and the top of its menu, as the state of the document's machine changes
 * them. Each dot comes from the same `plannerGlyph` as the real button: a healthy machine leaves
 * its own green, and no machine connected has no dot at all, never that green.
 */
let PRESENCE = [
	{ label: "Connected: the machine's own dot", planner: undefined },
	{ label: "Connecting to the machine", planner: status(STARTING) },
	{ label: "Can't connect to the machine", planner: status(FAILING) },
	{ label: "Machine offline", planner: status({ state: "disconnected", login: "mona" }) },
	{
		label: "Machine stepped away",
		planner: status({ state: "held", login: "mona", until: "2026-11-04T18:31:00.000Z" }),
	},
	{ label: "No machine connected: no dot", planner: status({ state: "none" }) },
] as const;

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
					<StateLabel>Talking to Chopin</StateLabel>
					<ComposerSpecimen chopin text="Review the spacing" />
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
					<StateLabel>Can't connect, with the machine button</StateLabel>
					<ComposerSpecimen notice={plannerPlacement(status(FAILING), true).strip} />
				</div>
				{WITHOUT_BUTTON.map(({ label, planner }) => (
					<div key={label}>
						<StateLabel>{label}</StateLabel>
						{/* Nobody here has the machine, so its owner's login is all that names it. */}
						<ComposerSpecimen notice={plannerPlacement(plannerStatus(planner), false).strip} />
					</div>
				))}
				<div>
					<StateLabel>Chopin working</StateLabel>
					<ComposerSpecimen run={{ action: "stop", disabled: false, onClick: () => {} }} />
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
			<div className="design-audit-planner-presence">
				{PRESENCE.map(({ label, planner }) => (
					<div key={label}>
						<StateLabel>{label}</StateLabel>
						<div className="design-audit-planner-glyph">
							<MachineGlyph
								machine={{ service: false, connected: true, reauthorize: false }}
								planner={plannerGlyph(planner)}
							/>
							{planner && <PlannerNote status={planner} />}
						</div>
					</div>
				))}
			</div>
		</AuditPlate>
	);
}
