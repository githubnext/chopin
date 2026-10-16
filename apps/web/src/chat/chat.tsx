/**
 * The chat pane.
 *
 * Drives the agent, and shows what it is doing. The composer stays live while
 * a turn runs — a turn owns the plan, not the chat — and anything sent
 * to the agent meanwhile is queued in order, with its author's name on it, so
 * nobody is silenced because a colleague prompted first.
 */

import { useEffect, useId, useLayoutEffect, useReducer, useRef, useState } from "react";

import {
	CONNECTION_GRACE,
	isDemoHandle,
	MAX_RESEARCH_BRIEF,
	useConnectionNotice,
	usePopoverDismissal,
} from "@chopin/editor";
import { chatDraftKey } from "../demo-actor";
import { canWithdraw } from "./withdraw";
import type { DraftInputHandle } from "./draft-input";
import { PlannerAttachment } from "./planner-attachment";
import { TypingReporter } from "./typing";
import { ChatComposer } from "./composer";

import { CommandPicker } from "./command-picker";
import {
	CHAT_COMMANDS,
	commandBrief,
	commandKeyAction,
	commandText,
	commandTrigger,
	commandTriggerKey,
	draftCommand,
	filterCommands,
} from "./commands";
import { MentionPicker } from "./mention-picker";
import {
	chatAuthors,
	filterMentions,
	insertMention,
	mentionCandidates,
	mentionKeyAction,
	mentionTrigger,
	mentionTriggerKey,
} from "./mentions";
import {
	referenceOptionId,
	ReferencePicker,
	referencePickerKeyAction,
	useReferencePicker,
} from "./reference-picker";
import {
	acknowledgeDraft,
	addressedOutsideReferences,
	addressesPlanner,
	boundedChatError,
	insertReference,
	MAX_REFERENCES,
	PLANNER_UNAVAILABLE_NOTICE,
	prepareDraftSubmission,
	reconcileReferenceDrafts,
	referenceTrigger,
	referenceTriggerKey,
	restoreDraftSubmission,
	reviseComposerDraft,
	withNoticesAfter,
} from "./references";
import { RunStack } from "./run-card";
import { Transcript } from "./transcript";
import { initialTranscript, transcriptReducer } from "./transcript-state";
import type { TranscriptDecisions } from "./transcript";
import type { CardLink } from "../conversation-plan/links";
import type { ExcerptCorrectionAction } from "../conversation-plan/analysis-overview";
import type { ChatDestination } from "../conversation-plan/source";
import type { ResearchOfferControls } from "./research-offer";

import type { Chat as Wire, ConversationPlan, Session } from "@chopin/protocol";
import type { Repository } from "../api";
import type { ResearchLaunchBlock, ResearchLaunchResult } from "@chopin/editor";
import type { ChatCommand } from "./commands";
import type { MentionCandidate } from "./mentions";
import type { ComposerDraft, ReferenceTarget } from "./references";
import type { Wire as Socket } from "../wire";

export type ChatProps = {
	/** The child document open beside this Chat, sent with a Planner message as its focus. */
	focus?: string;
	/** Open a child document and settle once it has synced. */
	onOpenChild?: (channelId: string) => Promise<boolean>;
	wire: Socket | undefined;
	handle: string;
	connected: boolean;
	readonly?: boolean;
	archived?: boolean;
	referencesEnabled: boolean;
	repository: Pick<Repository, "id" | "name" | "owner">;
	room: string;
	sendAcknowledgements: boolean;
	/** People connected to this document, for `@` suggestions. */
	people?: readonly string[];
	/** Hosted mode keeps the shared chat while repository-scoped agent work is disabled. */
	agent?: boolean;
	active?: boolean;
	/** `history` marks the transcript arriving, after which `busy` is known rather than assumed. */
	onActivity?: (event: { type: "message" | "working"; busy: boolean; history?: true }) => void;
	conversationPlan?: ConversationPlan.State;
	conversationPlanJobs?: ConversationPlan.Job[];
	onCardLink?: (link: CardLink) => void;
	onAddExcerpt?: (action: ExcerptCorrectionAction) => Promise<void>;
	onRetryAnalysis?: (
		messageId: string,
		actionId: string,
		lane?: "decision" | "research",
	) => Promise<void>;
	onRetryJob?: (jobId: string) => Promise<void>;
	decisions?: TranscriptDecisions;
	researchOffers?: ResearchOfferControls;
	sourceDestination?: ChatDestination;
	/** Opens Decisions, where a waiting workflow's questions are. */
	onShowDecisions?: () => void;
	/**
	 * Opens the document's research composer with this brief, when this
	 * document offers research, and says why when it cannot.
	 */
	onResearch?: (brief: string) => Promise<ResearchLaunchResult>;
	/** Focuses the research draft already open in the document. */
	onShowResearch?: () => void;
	/** Replaces the composer when this viewer cannot chat at all, such as in an archived document. */
	notice?: string;
	/** One calm line shown while the transcript has loaded and is still empty. */
	emptyNotice?: string;
	/** Who holds the document's remote Planner; absent under every other harness. */
	planner?: Session.PlannerAttachment;
	/** The viewer's own machine that is starting the Planner, by name, when one is. */
	plannerMachine?: string;
};

/** How many runs are still live, and how many are paused and resumable. */
export function runCounts(runs: Wire.Runs | undefined): { active: number; paused: number } {
	let list = runs ?? [];
	return {
		active: list.filter(run => run.status === "running" || run.status === "waiting").length,
		paused: list.filter(run => run.status === "paused").length,
	};
}

function draftKey(room: string, handle: string): string {
	return chatDraftKey(room, isDemoHandle(handle) ? handle : undefined);
}

/** Holds an unsent message across a reload of this tab; storage may refuse. */
function keepDraft(room: string, handle: string, draft: ComposerDraft): void {
	try {
		if (!draft.text.trim()) return sessionStorage.removeItem(draftKey(room, handle));
		sessionStorage.setItem(
			draftKey(room, handle),
			JSON.stringify({
				text: draft.text,
				references: draft.references,
				submission: draft.submission,
			}),
		);
	} catch {
		// Private windows and blocked storage: the draft is lost as it was before.
	}
}

/** The message a reload interrupted; anything malformed starts empty. */
function restoreDraft(room: string, handle: string): ComposerDraft {
	let empty = { text: "", references: [] };
	try {
		let raw = sessionStorage.getItem(draftKey(room, handle));
		if (!raw) return empty;
		let saved = JSON.parse(raw) as Partial<ComposerDraft>;
		if (typeof saved.text !== "string") return empty;
		let references = Array.isArray(saved.references)
				&& saved.references.every(reference =>
					typeof reference?.start === "number" && typeof reference.end === "number"
					&& reference.end <= saved.text!.length
				)
			? saved.references
			: [];
		let draft = { text: saved.text, references };
		let submission = restoreDraftSubmission(draft, saved.submission);
		return submission ? { ...draft, submission } : draft;
	} catch {
		return empty;
	}
}

export function Chat(
	{
		active = true,
		agent = true,
		focus,
		onOpenChild,
		readonly = false,
		archived = false,
		connected,
		handle,
		onActivity,
		conversationPlan,
		conversationPlanJobs,
		onCardLink,
		onAddExcerpt,
		onRetryAnalysis,
		onRetryJob,
		decisions,
		researchOffers,
		sourceDestination,
		people = [],
		notice,
		emptyNotice,
		planner,
		plannerMachine,
		onShowDecisions,
		onResearch,
		onShowResearch,
		referencesEnabled,
		repository,
		room,
		sendAcknowledgements,
		wire,
	}: ChatProps,
) {
	let [transcript, dispatchTranscript] = useReducer(transcriptReducer, initialTranscript);
	let { entries, turn } = transcript;
	let [queue, setQueue] = useState<Wire.Waiting[]>([]);
	let [unanswered, setUnanswered] = useState<Record<string, Wire.Entry>>({});
	let [busy, setBusy] = useState(false);
	let [runs, setRuns] = useState<Wire.Runs>();
	let [participation, setParticipation] = useState<{
		room: string;
		wire: Socket;
		state: Wire.Participation | undefined;
	}>();
	let [participationKey, setParticipationKey] = useState(0);
	let typing = useRef<TypingReporter | undefined>(undefined);
	let counts = runCounts(runs);
	let [draft, setDraft] = useState<ComposerDraft>(() => restoreDraft(room, handle));
	let [submitting, setSubmitting] = useState(false);
	// A send pressed during a blip, made once the connection is back.
	let [held, setHeld] = useState(false);
	let sending = submitting || held;
	let [sendError, setSendError] = useState<string>();
	let [researchBlock, setResearchBlock] = useState<ResearchLaunchBlock>();
	let researching = useRef(false);
	let [selection, setSelection] = useState({ start: 0, end: 0 });
	let [dismissedPicker, setDismissedPicker] = useState<string>();
	let [mentionCursor, setMentionCursor] = useState<{ key?: string; index: number }>({ index: 0 });
	let [commandCursor, setCommandCursor] = useState<{ key?: string; index: number }>({ index: 0 });
	let textarea = useRef<DraftInputHandle>(null);
	let composerRoot = useRef<HTMLDivElement>(null);
	let [mode, setMode] = useState(() =>
		draft.submission?.to === "planner" && !addressedOutsideReferences(draft.text, draft.references)
	);
	let [historyKey, setHistoryKey] = useState(0);
	let pendingCaret = useRef<number | { start: number; end: number } | undefined>(undefined);
	let submission = useRef<object | undefined>(undefined);
	let draftRef = useRef(draft);
	draftRef.current = draft;
	// A reload, including the header's fallback when reconnecting keeps
	// failing, must not take an unsent message with it. Kept as it changes
	// rather than on unload, which a browser does not promise to announce.
	useEffect(() => keepDraft(room, handle, draft), [room, handle, draft]);
	let pickerId = useId();
	let mentionPickerId = useId();
	let commandPickerId = useId();
	let synchronized = useRef<Socket | undefined>(undefined);
	let activity = useRef(onActivity);
	let reportedBusy = useRef(false);
	activity.current = onActivity;
	// A socket opens before its fresh transcript arrives, and reconnects reuse
	// the same Wire. Only that transcript makes this composer current.
	if (!connected) synchronized.current = undefined;
	let transcriptReady = connected && synchronized.current === wire;
	let composerReady = transcriptReady && !readonly && !archived;
	let participationState = transcriptReady && participation?.room === room
			&& participation.wire === wire
		? participation.state
		: undefined;
	let typingEnabled = composerReady && active && agent && !!participationState?.enabled;
	// A draft never waits on the connection; only sending does.
	let draftable = !readonly && !archived;
	let connectionNotice = useConnectionNotice(!connected);
	let connectionLabel = connectionNotice === "none"
		? undefined
		: connectionNotice === "offline" || wire?.status === "closed" || wire?.status === "denied"
		? "Offline"
		: wire?.status === "connecting"
		? "Connecting…"
		: "Reconnecting…";
	let effectiveMode = !!agent && (mode || draft.submission?.to === "planner"
		|| addressedOutsideReferences(draft.text, draft.references));
	let workingTurn = transcriptReady ? turn : undefined;
	let suspendedWork = !transcriptReady && turn && transcript.activeAnchorId
		? {
			turnId: turn.id,
			entryOffset: turn.entryOffset,
			endOffset: entries.length,
			anchorId: transcript.activeAnchorId,
		}
		: undefined;
	let detected = referencesEnabled && composerReady && !submitting
		? referenceTrigger(draft.text, selection.start, selection.end)
		: undefined;
	let trigger = detected
			&& !draft.references.some(reference =>
				reference.start < detected.end && reference.end > detected.start
			)
		? detected
		: undefined;
	let triggerKey = trigger ? referenceTriggerKey(trigger) : undefined;
	let pickerOpen = !submitting && trigger !== undefined && triggerKey !== dismissedPicker;
	let atReferenceLimit = draft.references.length >= MAX_REFERENCES;
	let picker = useReferencePicker(
		pickerOpen && !atReferenceLimit && referencesEnabled ? trigger : undefined,
		repository,
		room,
	);
	let authors = chatAuthors(entries);
	let mention = composerReady && !submitting && !detected
		? mentionTrigger(draft.text, selection.start, selection.end)
		: undefined;
	let mentionKey = mention ? mentionTriggerKey(mention) : undefined;
	let mentionOptions = mention
			&& !draft.references.some(reference =>
				reference.start < mention.end && reference.end > mention.start
			)
		? filterMentions(
			mentionCandidates({ authors, people, planner: agent, self: handle }),
			mention.query,
		)
		: [];
	let mentionOpen = mentionOptions.length > 0 && mentionKey !== dismissedPicker;
	let mentionActive = mentionCursor.key === mentionKey
		? Math.min(mentionCursor.index, mentionOptions.length - 1)
		: 0;
	let activeMention: MentionCandidate | undefined = mentionOpen
		? mentionOptions[mentionActive]
		: undefined;
	let command = composerReady && !submitting
		? commandTrigger(draft.text, selection.start, selection.end)
		: undefined;
	let commandKey = command ? commandTriggerKey(command) : undefined;
	let commandOptions = command && onResearch ? filterCommands(CHAT_COMMANDS, command.query) : [];
	let commandOpen = commandOptions.length > 0 && commandKey !== dismissedPicker;
	let commandActive = commandCursor.key === commandKey
		? Math.min(commandCursor.index, commandOptions.length - 1)
		: 0;
	// Without research here, a `/research` draft is held with a notice rather than posted.
	let blockedCommand = !onResearch && !!draftCommand(draft.text);
	// Escape keeps the draft and the composer's focus; only the picker closes.
	usePopoverDismissal(
		commandOpen || mentionOpen || pickerOpen,
		target =>
			composerRoot.current?.contains(target)
			&& !!(target as Element).closest?.(
				"[contenteditable], [data-chat-command-picker], [data-chat-mention-picker], [data-chat-reference-picker]",
			),
		() => setDismissedPicker(commandOpen ? commandKey : mentionOpen ? mentionKey : triggerKey),
	);
	let activeOption = picker.options.length === 0
		? undefined
		: picker.options[Math.min(picker.active, picker.options.length - 1)];

	useEffect(() => {
		if (!wire) return;
		// History seeds `seen`; only later message frames are arrivals.
		let loaded = false;
		let seen = new Set<string>();
		let response = (agent: boolean, value: string) => {
			if (!agent || !value.trim()) return;
			dispatchTranscript({ kind: "responded" });
		};

		// Streaming arrives as deltas against an entry already in the list, so
		// the reducer here has to be additive rather than replacing.
		let off = [
			wire.on<Wire.History>("chat:history", frame => {
				loaded = true;
				synchronized.current = wire;
				seen = new Set(frame.entries.map(entry => entry.id));
				dispatchTranscript({ kind: "history", entries: frame.entries, turn: frame.turn });
				setQueue(frame.queued);
				setBusy(frame.busy);
				reportedBusy.current = frame.busy;
				setRuns(frame.runs);
				setParticipation({ room, wire, state: frame.participation });
				setParticipationKey(current => current + 1);
				// History is not unread, but a turn already in progress still needs
				// a signal outside a closed Chat destination.
				activity.current?.({ type: "working", busy: frame.busy, history: true });
			}),
			wire.on<Wire.Message>("chat:message", frame => {
				if (loaded && !seen.has(frame.entry.id)) {
					activity.current?.({ type: "message", busy: reportedBusy.current });
				}
				seen.add(frame.entry.id);
				dispatchTranscript({ kind: "message", entry: frame.entry });
				response(frame.entry.author.kind === "agent", frame.entry.text);
			}),
			wire.on<Wire.Delta>("chat:delta", frame => {
				dispatchTranscript({ kind: "delta", id: frame.id, text: frame.text });
				response(true, frame.text);
			}),
			wire.on<Wire.Tool>("chat:tool", frame => {
				dispatchTranscript({ kind: "tool", entryId: frame.entry, activity: frame.activity });
			}),
			wire.on<Wire.State>("chat:state", frame => {
				if (loaded && reportedBusy.current !== frame.busy) {
					activity.current?.({ type: "working", busy: frame.busy });
				}
				reportedBusy.current = frame.busy;
				setBusy(frame.busy);
				dispatchTranscript({ kind: "turn", turn: frame.turn });
				setRuns(frame.runs);
			}),
			wire.on<Wire.Queue>("chat:queue", frame => setQueue(frame.waiting)),
			wire.on<Wire.ParticipationState>("chat:participation", frame => {
				if (!loaded || synchronized.current !== wire) return;
				setParticipation({ room, wire, state: { enabled: frame.enabled, paused: frame.paused } });
			}),
		];

		return () => {
			for (let unsubscribe of off) unsubscribe();
		};
	}, [wire, room]);

	useEffect(() => {
		if (!wire || !typingEnabled) return;
		let reporter = new TypingReporter(active => {
			if (wire.connected) wire.send("chat:typing", { active });
		});
		typing.current = reporter;
		return () => {
			reporter.stop();
			if (typing.current === reporter) typing.current = undefined;
		};
	}, [wire, room, typingEnabled, participationKey]);

	useLayoutEffect(() => {
		if (pendingCaret.current === undefined) return;
		let caret = pendingCaret.current;
		pendingCaret.current = undefined;
		textarea.current?.focus();
		textarea.current?.setSelectionRange(
			typeof caret === "number" ? caret : caret.start,
			typeof caret === "number" ? caret : caret.end,
		);
	});

	let restoreComposerFocus = () => {
		requestAnimationFrame(() => textarea.current?.focus());
	};
	let clearSubmittedDraft = (submitted: ComposerDraft) => {
		if (draftRef.current !== submitted) return;
		let cleared = acknowledgeDraft(submitted, submitted);
		draftRef.current = cleared;
		setDraft(cleared);
		setSelection({ start: 0, end: 0 });
		setDismissedPicker(undefined);
		setHistoryKey(current => current + 1);
	};

	/** `text` replaces a draft that is not yet the command, so Retry can reopen it. */
	let launchResearch = (brief: string, text?: string) => {
		if (!onResearch || researching.current) return;
		researching.current = true;
		setResearchBlock(undefined);
		setSendError(undefined);
		let started = draftRef.current;
		void onResearch(brief).then(result => {
			// The draft is cleared only once the document composer holds the brief.
			// Compare text: hiding the pane can re-emit an unchanged draft.
			if (draftRef.current.text !== started.text) return;
			let next = result.ok ? "" : text;
			if (next !== undefined) {
				let revised = reviseComposerDraft(started, next, []);
				draftRef.current = revised;
				setDraft(revised);
				setSelection({ start: next.length, end: next.length });
				setDismissedPicker(undefined);
				if (!result.ok) pendingCaret.current = next.length;
			}
			if (!result.ok) setResearchBlock(result.reason);
		}).finally(() => {
			researching.current = false;
		});
	};

	let submit = () => {
		if (submission.current || !draftable) return;
		typing.current?.stop();
		let current = draftRef.current;
		if (draftCommand(current.text)) {
			// `#` references stay in the brief as their visible titles.
			launchResearch(commandBrief(current.text));
			return;
		}
		if (!current.text.trim()) return;
		if (!composerReady || !wire?.connected) {
			// Inside the grace period nothing says the connection is down, so
			// the send waits for it rather than being refused.
			if (connectionNotice === "none") setHeld(true);
			return;
		}
		let submitted = prepareDraftSubmission(current, undefined, {
			planner: agent,
			mode: effectiveMode,
			referencesEnabled,
			focus,
		});
		if (!submitted) return;
		let payload = submitted.submission;
		let token = {};
		submission.current = token;
		draftRef.current = submitted;
		setDraft(submitted);
		keepDraft(room, handle, submitted);
		setSubmitting(true);
		setSendError(undefined);

		if (!agent && addressesPlanner(payload)) {
			setUnanswered(current => ({
				...current,
				[payload.requestId]: {
					id: `unanswered-${payload.requestId}`,
					author: { kind: "system" },
					text: PLANNER_UNAVAILABLE_NOTICE,
					ts: Date.now(),
				},
			}));
		}
		if (!sendAcknowledgements) {
			wire.send("chat:send", payload);
			clearSubmittedDraft(submitted);
			submission.current = undefined;
			setSubmitting(false);
			restoreComposerFocus();
			return;
		}
		void wire.ask<Wire.Sent>("chat:send", payload).then(() => {
			clearSubmittedDraft(submitted);
		}, error => {
			setSendError(boundedChatError(error));
		}).finally(() => {
			if (submission.current !== token) return;
			submission.current = undefined;
			setSubmitting(false);
			restoreComposerFocus();
		});
	};

	// Stop and Resume pressed during a blip are sent once it is over, or never.
	let heldControl = useRef<"chat:abort" | "chat:resume">(undefined);
	let control = (kind: "chat:abort" | "chat:resume") => {
		if (wire?.connected) wire.send(kind);
		else heldControl.current = kind;
	};
	useEffect(() => {
		if (connectionNotice !== "none") heldControl.current = undefined;
		else if (connected && heldControl.current && wire?.connected) {
			wire.send(heldControl.current);
			heldControl.current = undefined;
		}
	});

	// Never held longer than the grace period, however the wait ends.
	useEffect(() => {
		if (!held) return;
		let timer = setTimeout(() => setHeld(false), CONNECTION_GRACE);
		return () => clearTimeout(timer);
	}, [held]);
	useEffect(() => {
		if (!held) return;
		if (connectionNotice !== "none") {
			setHeld(false);
		} else if (composerReady && wire?.connected) {
			setHeld(false);
			submit();
		}
	});

	let toggleMode = () => {
		if (!draftable || sending || !agent) return;
		let current = draftRef.current;
		let at = selection.start;
		let end = selection.end;
		if (effectiveMode) {
			let removals = [...current.text.matchAll(/(^|[^\w@])@chopin\b/gi)]
				.map(match => {
					let start = match.index + match[1]!.length;
					let end = match.index + match[0].length;
					// Take one following space too where the mention began the text or followed one,
					// so removing it leaves no doubled or leading space.
					let before = current.text[start - 1];
					if (current.text[end] === " " && (start === 0 || before === " ")) end += 1;
					return { start, end };
				})
				.filter(edit =>
					!current.references.some(reference =>
						edit.start < reference.end && edit.end > reference.start
					)
				);
			let next = current.text;
			let references = current.references;
			for (let edit of removals.toReversed()) {
				let revised = next.slice(0, edit.start) + next.slice(edit.end);
				references = reconcileReferenceDrafts(next, revised, references, edit);
				if (edit.start < at) at -= Math.min(edit.end - edit.start, at - edit.start);
				if (edit.start < end) end -= Math.min(edit.end - edit.start, end - edit.start);
				next = revised;
			}
			setDraft({ text: next, references });
			setSelection({ start: at, end });
			setMode(false);
		} else {
			setMode(true);
			setDraft({ text: current.text, references: current.references });
		}
		setSendError(undefined);
		setDismissedPicker(triggerKey ?? mentionKey);
		pendingCaret.current = { start: at, end };
	};

	let chooseReference = (target: ReferenceTarget) => {
		if (!trigger) return;
		let next = insertReference(draft.text, draft.references, trigger, target);
		setDraft(current => reviseComposerDraft(current, next.text, next.references));
		setSelection({ start: next.caret, end: next.caret });
		setSendError(undefined);
		setDismissedPicker(undefined);
		pendingCaret.current = next.caret;
	};

	let chooseMention = (candidate: MentionCandidate) => {
		if (!mention) return;
		let next = insertMention(draft.text, mention, candidate);
		if (candidate.kind === "planner") setMode(true);
		setDraft(current =>
			reviseComposerDraft(
				current,
				next.text,
				reconcileReferenceDrafts(
					current.text,
					next.text,
					current.references,
					{ start: mention.start, end: mention.end },
				),
			)
		);
		setSelection({ start: next.caret, end: next.caret });
		setSendError(undefined);
		setDismissedPicker(undefined);
		pendingCaret.current = next.caret;
	};

	let moveMention = (to: (index: number) => number) =>
		setMentionCursor({ key: mentionKey, index: to(mentionActive) });

	let chooseCommand = (choice: ChatCommand) => launchResearch("", commandText(choice));

	let researchCopy: Record<ResearchLaunchBlock, string> = {
		"too-long": `Briefs can be up to ${MAX_RESEARCH_BRIEF.toLocaleString("en-US")} characters`,
		drafting: "A research request is already being written in the document",
		"read-only": "This document is read-only",
		disconnected: "Reconnecting… try again in a moment",
		unavailable: "Research couldn’t open in the document",
	};

	let transcriptView = (
		<Transcript
			active={active}
			canEdit={composerReady}
			emptyHint={readonly || archived
				? undefined
				: {
					planner: !!agent,
					references: referencesEnabled,
					automatic: participationState?.enabled,
				}}
			conversationPlanJobs={conversationPlanJobs}
			onCardLink={onCardLink}
			onAddExcerpt={onAddExcerpt}
			onOpenChild={onOpenChild}
			room={room}
			onRetryAnalysis={onRetryAnalysis}
			onRetryJob={onRetryJob}
			conversationPlan={conversationPlan}
			decisions={decisions}
			empty={transcriptReady && entries.length === 0 && queue.length === 0 && !turn
				? emptyNotice
				: undefined}
			researchOffers={researchOffers}
			sourceDestination={sourceDestination}
			entries={withNoticesAfter(entries, unanswered)}
			completedWork={transcript.completedWork}
			suspendedWork={suspendedWork}
			handle={handle}
			live={transcriptReady}
			onWithdraw={id => {
				if (canWithdraw(queue, id, handle)) wire?.send("chat:unqueue", { id });
			}}
			queued={queue}
			working={workingTurn}
		/>
	);
	if (notice) {
		return (
			<div className="flex h-full min-h-0 flex-col">
				{transcriptView}
				<div className="chat-composer shrink-0 px-2.5 pb-2.5">
					<p className="px-4 py-3 text-sm text-text-tertiary">{notice}</p>
					<PlannerAttachment machine={plannerMachine} planner={planner} />
				</div>
			</div>
		);
	}

	return (
		<div className="flex h-full min-h-0 flex-col">
			{transcriptView}

			{agent && !!runs?.length && (
				<div className="flex shrink-0 flex-col px-2.5 pb-2" data-chat-runs="">
					<RunStack
						onPause={runId =>
							wire?.send("chat:pause-run", { runId })}
						onResume={runId =>
							wire?.send("chat:resume-run", { runId })}
						onShowDecisions={onShowDecisions}
						runs={runs}
					/>
				</div>
			)}

			<ChatComposer
				rootRef={composerRoot}
				inputRef={textarea}
				agent={!!agent}
				mode={{
					chopin: effectiveMode,
					disabled: !draftable || sending || !agent,
					onToggle: toggleMode,
				}}
				notice={sendError
					? {
						tone: "error",
						text: sendError,
						action: { label: "Retry", onClick: submit, disabled: !composerReady || submitting },
					}
					: researchBlock
					? {
						tone: "info",
						text: researchCopy[researchBlock],
						action: researchBlock === "drafting"
							? onShowResearch && { label: "Go to it", onClick: onShowResearch }
							: researchBlock === "disconnected" || researchBlock === "unavailable"
							? { label: "Retry", onClick: submit }
							: undefined,
					}
					: blockedCommand
					? { tone: "info", text: "Research isn’t available in this document" }
					: !agent
					? { tone: "info", text: "Chopin unavailable" }
					: undefined}
				unavailable={archived ? "archived" : readonly ? "readonly" : undefined}
				references={referencesEnabled
					? {
						disabled: !composerReady || submitting,
						onMentionDocs: () => {
							let current = draftRef.current;
							let next = current.text
								+ (current.text && !current.text.endsWith(" ") ? " #" : "#");
							setDraft(reviseComposerDraft(current, next, current.references));
							setSelection({ start: next.length, end: next.length });
							setDismissedPicker(undefined);
							pendingCaret.current = next.length;
						},
					}
					: undefined}
				draftable={draftable}
				sending={sending}
				sendDisabled={!draftable || sending || !draft.text.trim()
					|| blockedCommand
					|| (connectionNotice !== "none" && !draftCommand(draft.text))}
				onSubmit={submit}
				connectionLabel={connectionLabel}
				onReconnect={connectionNotice === "offline" && wire ? () => wire.reconnect() : undefined}
				run={agent && (busy || counts.active > 0)
					? {
						action: "stop",
						disabled: !composerReady && connectionNotice !== "none",
						onClick: () => control("chat:abort"),
					}
					: agent && !busy && !counts.active && counts.paused > 0
					? {
						action: "resume",
						disabled: !composerReady && connectionNotice !== "none",
						onClick: () => control("chat:resume"),
					}
					: undefined}
				pickers={
					<>
						{pickerOpen && trigger && (
							<ReferencePicker
								active={picker.active}
								id={pickerId}
								onActive={picker.setActive}
								onSelect={chooseReference}
								state={atReferenceLimit
									? { status: "limit", options: [] }
									: picker}
							/>
						)}
						{commandOpen && (
							<CommandPicker
								active={commandActive}
								id={commandPickerId}
								onActive={index => setCommandCursor({ key: commandKey, index })}
								onSelect={chooseCommand}
								options={commandOptions}
							/>
						)}
						{mentionOpen && (
							<MentionPicker
								active={mentionActive}
								id={mentionPickerId}
								onActive={index => setMentionCursor({ key: mentionKey, index })}
								onSelect={chooseMention}
								options={mentionOptions}
							/>
						)}
					</>
				}
				attachment={<PlannerAttachment machine={plannerMachine} planner={planner} />}
				input={{
					"aria-activedescendant": commandOpen
						? referenceOptionId(commandPickerId, commandActive)
						: mentionOpen
						? referenceOptionId(mentionPickerId, mentionActive)
						: pickerOpen && activeOption
						? referenceOptionId(pickerId, picker.options.indexOf(activeOption))
						: undefined,
					"aria-controls": commandOpen
						? commandPickerId
						: mentionOpen
						? mentionPickerId
						: pickerOpen
						? pickerId
						: undefined,
					"aria-expanded": commandOpen || pickerOpen || mentionOpen,
					resetKey: historyKey,
					references: draft.references,
					mentions: [
						handle,
						...mentionCandidates({ authors, people, planner: agent, self: handle }).map(
							candidate => candidate.login,
						),
					],
					onChange: event => {
						let next = event.currentTarget.value;
						if (next !== draftRef.current.text) typing.current?.change();
						setDraft(current =>
							reviseComposerDraft(
								current,
								next,
								event.currentTarget.references
									?? reconcileReferenceDrafts(current.text, next, current.references),
							)
						);
						setSendError(undefined);
						setResearchBlock(undefined);
						setDismissedPicker(undefined);
						setSelection({
							start: event.currentTarget.selectionStart,
							end: event.currentTarget.selectionEnd,
						});
					},
					onBlur: () => typing.current?.stop(),
					onKeyDown: event => {
						let composing = event.nativeEvent.isComposing || event.keyCode === 229;
						let commandAction = commandOpen
							? commandKeyAction({
								key: event.key,
								keyCode: event.keyCode,
								isComposing: event.nativeEvent.isComposing,
								shiftKey: event.shiftKey,
								altKey: event.altKey,
								ctrlKey: event.ctrlKey,
								metaKey: event.metaKey,
							}, true)
							: undefined;
						if (commandAction === "next" || commandAction === "previous") {
							let step = commandAction === "next" ? 1 : -1;
							setCommandCursor({
								key: commandKey,
								index: (commandActive + step + commandOptions.length)
									% commandOptions.length,
							});
							event.preventDefault();
							return;
						}
						if (commandAction === "select") {
							chooseCommand(commandOptions[commandActive]!);
							event.preventDefault();
							return;
						}
						if (!composing && event.key === "Tab" && !event.shiftKey) {
							setDismissedPicker(mentionKey ?? triggerKey);
							return;
						}
						if (
							!composing && event.key === "Tab" && event.shiftKey && !event.metaKey
							&& !event.ctrlKey && !event.altKey && agent && draftable && !sending
						) {
							event.preventDefault();
							if (!event.repeat) toggleMode();
							return;
						}
						let mentionAction = mentionOpen
							? mentionKeyAction({
								key: event.key,
								keyCode: event.keyCode,
								isComposing: event.nativeEvent.isComposing,
								shiftKey: event.shiftKey,
								altKey: event.altKey,
								ctrlKey: event.ctrlKey,
								metaKey: event.metaKey,
							}, true)
							: undefined;
						if (mentionAction === "next") {
							moveMention(index => (index + 1) % mentionOptions.length);
							event.preventDefault();
							return;
						}
						if (mentionAction === "previous") {
							moveMention(index => (index - 1 + mentionOptions.length) % mentionOptions.length);
							event.preventDefault();
							return;
						}
						if (mentionAction === "select" && activeMention) {
							chooseMention(activeMention);
							event.preventDefault();
							return;
						}
						let action = pickerOpen
							? referencePickerKeyAction({
								key: event.key,
								keyCode: event.keyCode,
								isComposing: event.nativeEvent.isComposing,
								shiftKey: event.shiftKey,
							}, activeOption !== undefined)
							: undefined;
						if (action === "next") {
							picker.setActive(value =>
								picker.options.length === 0 ? 0 : (value + 1) % picker.options.length
							);
							event.preventDefault();
							return;
						}
						if (action === "previous") {
							picker.setActive(value =>
								picker.options.length === 0
									? 0
									: (value - 1 + picker.options.length) % picker.options.length
							);
							event.preventDefault();
							return;
						}
						if (action === "select" && activeOption) {
							chooseReference(activeOption);
							event.preventDefault();
							return;
						}
						if (composing) return;
						if (event.key !== "Enter" || event.shiftKey) return;
						event.preventDefault();
						submit();
					},
					onSelect: event =>
						setSelection({
							start: event.currentTarget.selectionStart,
							end: event.currentTarget.selectionEnd,
						}),
					value: draft.text,
				}}
			/>
		</div>
	);
}
