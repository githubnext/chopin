import { useState } from "react";
import type { ReactNode } from "react";

import { ChatComposer } from "../../chat/composer";
import { ConnectionBannerView } from "../../chat/connection-banner";
import { connectionStep, INITIAL_MEMORY } from "../../chat/connection-phase";
import { ErrorState } from "../../chat/error-state";
import { failureView } from "../../chat/failure";
import { plannerGlyph, plannerStatus } from "../../chat/planner-status";
import { MachineGlyph, PlannerNote } from "../../machine-button";
import { boundedChatError } from "../../chat/references";
import { mentionCandidates } from "../../chat/mentions";
import { Transcript } from "../../chat/transcript";
import { AuditPlate, StateLabel } from "../frame";

import type { Chat, Session } from "@chopin/protocol";
import type { FileView } from "../../chat/attachments/files";
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
	& Pick<ChatComposerProps, "banner" | "notice" | "run" | "unavailable">
	& {
		sending?: boolean;
		text?: string;
		chopin?: boolean;
		/** Images and files are taken: the + attaches, and these are staged above the text. */
		files?: FileView[];
		/** Speech can be turned into words: the microphone, and the voice while it listens. */
		dictation?: "idle" | "listening";
	};

/** The files staged for the specimen's message: a picture, one uploading and one refused. */
const STAGED: FileView[] = [
	{
		id: "picture",
		name: "shot.png",
		kind: "image",
		size: 52_000,
		sizeLabel: "51 KB",
		state: "done",
		progress: 100,
		retry: false,
	},
	{
		id: "uploading",
		name: "notes.md",
		kind: "file",
		size: 2048,
		sizeLabel: "40%",
		state: "uploading",
		progress: 40,
		retry: false,
	},
	{
		id: "refused",
		name: "logo.svg",
		kind: "image",
		size: 900,
		sizeLabel: "900 B",
		state: "error",
		progress: 0,
		error: "logo.svg isn't a PNG, JPEG, WebP or GIF image.",
		retry: false,
	},
];

/** The live composer, holding its own draft so the specimen can be typed into. */
export function ComposerSpecimen(
	{
		chopin = false,
		banner,
		dictation,
		files,
		notice,
		run,
		sending = false,
		text = "",
		unavailable,
	}: Specimen,
) {
	let [draft, setDraft] = useState(text);
	let [chip, setChip] = useState(chopin);
	let draftable = !unavailable;
	return (
		<ChatComposer
			agent
			chopin={{
				chip,
				disabled: !draftable || sending,
				onAdd: () => setChip(true),
				onRemove: () => setChip(false),
			}}
			banner={banner}
			dictation={dictation
				? {
					active: dictation === "listening",
					phase: dictation === "listening" ? "listening" : "idle",
					seconds: 65,
					tooltip: "Dictate (Alt+Shift+M). Speech is turned into words on this device.",
					announcement: "",
					disabled: !draftable || sending,
					onToggle: () => {},
				}
				: undefined}
			draftable={draftable}
			files={files
				? {
					files,
					source: () => undefined,
					disabled: !draftable || sending,
					waiting: false,
					onAdd: () => {},
					onRemove: () => {},
					onRetry: () => {},
				}
				: undefined}
			notice={notice}
			onSubmit={() => {}}
			references={{ disabled: false, onMentionDocs: () => setDraft(value => `${value}#`) }}
			format={{ shown: true, disabled: !draftable, onToggle: () => {}, onFormat: () => {} }}
			mention={{ disabled: !draftable, onMention: () => setDraft(value => `${value}@`) }}
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

const WELL = {
	socket: "up",
	failures: 0,
	retrying: undefined,
	synced: true,
	current: true,
	turn: undefined,
	messages: 12,
	planner: undefined,
} as const;

function connection(facts: Partial<Parameters<typeof connectionStep>[1]>, resumed = false) {
	let lost = connectionStep(INITIAL_MEMORY, { ...WELL, turn: "audit-turn", ...facts });
	if (!resumed) return lost.view;
	return connectionStep(
		connectionStep(INITIAL_MEMORY, { ...WELL, turn: "audit-turn", socket: "lost" }).memory,
		{
			...WELL,
			turn: "audit-turn",
			messages: 15,
		},
	).view;
}

/**
 * The one banner above the composer, in each phase: the room's connection, the document catching
 * up, the machine's own connection, and a failed reply. Each shows nothing while all is well.
 */
let BANNERS: { label: string; node: ReactNode }[] = [
	{
		label: "Reconnecting, with its attempt",
		node: (
			<ConnectionBannerView
				onRetry={undefined}
				view={connection({ socket: "lost", failures: 2 })}
			/>
		),
	},
	{
		label: "Dropped, Reconnect",
		node: (
			<ConnectionBannerView
				onRetry={() => {}}
				view={connection({ socket: "lost", failures: 4 })}
			/>
		),
	},
	{
		label: "Back, the reply kept going",
		node: <ConnectionBannerView onRetry={undefined} view={connection({}, true)} />,
	},
	// Nobody here has the machine's name, so its owner's login is all that names it.
	{
		label: "Connecting to the machine",
		node: (
			<ConnectionBannerView
				onRetry={undefined}
				view={connection({ planner: plannerStatus(STARTING) })}
			/>
		),
	},
	{
		label: "Can't connect to the machine, reason and Try again",
		node: (
			<ConnectionBannerView
				onRetry={() => {}}
				view={connection({ planner: plannerStatus(FAILING) })}
			/>
		),
	},
	{
		label: "Machine offline",
		node: (
			<ConnectionBannerView
				onRetry={undefined}
				view={connection({ planner: plannerStatus({ state: "disconnected", login: "mona" }) })}
			/>
		),
	},
	{
		label: "Machine stepped away",
		node: (
			<ConnectionBannerView
				onRetry={undefined}
				view={connection({
					planner: plannerStatus({
						state: "held",
						login: "mona",
						until: "2026-11-04T18:31:00.000Z",
					}),
				})}
			/>
		),
	},
	{
		label: "No machine connected",
		node: (
			<ConnectionBannerView
				onRetry={undefined}
				view={connection({ planner: plannerStatus({ state: "none" }) })}
			/>
		),
	},
	{
		label: "Reply failed, Retry",
		node: <FailureSpecimen failure={{ kind: "error", detail: "429 Too Many Requests" }} retry />,
	},
	{
		label: "Retrying",
		node: <FailureSpecimen failure={{ kind: "timed-out" }} retry retrying />,
	},
	{
		label: "Reply refused, nothing to retry",
		node: <FailureSpecimen failure={{ kind: "refused" }} />,
	},
];

function FailureSpecimen(
	{ failure, retry = false, retrying = false }: {
		failure: Chat.TurnFailure;
		retry?: boolean;
		retrying?: boolean;
	},
) {
	let view = failureView(failure)!;
	return (
		<ErrorState
			detail={view.detail}
			kind={view.kind}
			onRetry={retry ? () => {} : undefined}
			retrying={retrying}
			title={view.title}
		/>
	);
}

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
			description="Member, Chopin, tool activity, queued work, composer, and error states."
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
				{BANNERS.map(({ label, node }) => (
					<div key={label}>
						<StateLabel>{label}</StateLabel>
						<ComposerSpecimen banner={{ id: label, node }} />
					</div>
				))}
				<div>
					<StateLabel>Files staged, and the microphone</StateLabel>
					<ComposerSpecimen
						dictation="idle"
						files={STAGED}
						text="The plan and a picture of the cap"
					/>
				</div>
				<div>
					<StateLabel>Dictating</StateLabel>
					<ComposerSpecimen dictation="listening" text="Ship the cap" />
				</div>
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
