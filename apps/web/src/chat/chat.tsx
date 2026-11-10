/**
 * The chat pane.
 *
 * Drives the agent, and shows what it is doing. The composer stays live while
 * a turn runs — a turn owns the plan, not the chat — and anything sent
 * to the agent meanwhile is queued in order, with its author's name on it, so
 * nobody is silenced because a colleague prompted first.
 */

import {
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useReducer,
	useRef,
	useState,
} from "react";

import {
	connectionGrace,
	isDemoHandle,
	MAX_RESEARCH_BRIEF,
	useConnectionNotice,
	usePendingWork,
	usePopoverDismissal,
} from "@chopin/editor";
import { chatDraftKey } from "../demo-actor";
import { WireLost, WireRefusal } from "../wire";
import { MessageQueue } from "./message-queue";
import { queueRows, refusalWords } from "./queue-model";
import {
	echoes,
	keepOutbox,
	keepRetractions,
	nextToSend,
	outboxReducer,
	passing,
	refusalText,
	restoreOutbox,
	restoreRetractions,
	retractionFor,
	retractionSettledBy,
	retractionsReducer,
	withoutRetracted,
} from "./delivery";
import type { DraftInputHandle } from "./draft-input";
import { bannerSlot } from "./banner-slot";
import { ConnectionBannerView } from "./connection-banner";
import type { ConnectionBanner, TranscriptFacts } from "./connection-banner";
import { silencesFailedSends } from "./connection-phase";
import { ErrorState } from "./error-state";
import { failureBanner, retryPayload, sendFailureView, withoutFailure } from "./failure";
import { TypingReporter } from "./typing";
import { ChatComposer } from "./composer";
import type { ComposerNotice } from "./composer";

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
import { composerModelNotice } from "./model-picker-state";
import { useModelChoice } from "./use-model-choice";
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
	insertReference,
	MAX_REFERENCES,
	PLANNER_UNAVAILABLE_NOTICE,
	prepareDraftSubmission,
	reconcileReferenceDrafts,
	referenceTrigger,
	referenceTriggerKey,
	repliesOffNotice,
	restoreDraftSubmission,
	reviseComposerDraft,
	sendFailure,
	shownSendFailure,
	withNoticesAfter,
} from "./references";
import { runCounts, RunStack } from "./run-card";
import { runStages } from "../api";
import { Transcript } from "./transcript";
import {
	initialTranscript,
	progressOf,
	silentRestart,
	transcriptReducer,
} from "./transcript-state";
import type { TranscriptDecisions } from "./transcript";
import type { CardLink } from "../conversation-plan/links";
import type { ExcerptCorrectionAction } from "../conversation-plan/analysis-overview";
import type { ChatDestination } from "../conversation-plan/source";
import type { ResearchOfferControls } from "./research-offer";

import type { Chat as Wire, ConversationPlan } from "@chopin/protocol";
import type { Repository } from "../api";
import type { ResearchLaunchBlock, ResearchLaunchResult } from "@chopin/editor";
import type { ChatCommand } from "./commands";
import type { MentionCandidate } from "./mentions";
import type { ComposerDraft, ReferenceTarget, SendFailure } from "./references";
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
	/** The page is showing its connection banner, which is the one thing said about the connection. */
	offline?: boolean;
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
	/**
	 * The page's one connection banner: its phase, and what Reconnect asks for. Chat draws it above
	 * the composer when it is on screen; the page draws it at the document otherwise.
	 */
	banner?: ConnectionBanner;
	/** What the transcript tells the banner: a reply running, its size, and whether it is current. */
	onTranscript?: (facts: TranscriptFacts) => void;
};

/** How long a message the server had no room for waits before it is sent again. */
const FULL_RETRY_MS = 5_000;
/** How long before a delete the server refused for a passing reason is asked again. */
const RETRACTION_RETRY_MS = 5_000;

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
		offline = false,
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
		banner,
		onTranscript,
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
	// What was sent to the machine and the server has not shown back yet: shown at once as the
	// person's own, sent when the connection allows, and in order.
	let [outbox, dispatchOutbox] = useReducer(
		outboxReducer,
		undefined,
		() => restoreOutbox(room, handle),
	);
	// What the person took back that the server has not answered for: hidden at once, asked about
	// again until it answers, and kept across a reload so that the message does not come back.
	let [retractions, dispatchRetractions] = useReducer(
		retractionsReducer,
		undefined,
		() => restoreRetractions(room, handle),
	);
	let sendingId = useRef<string | undefined>(undefined);
	let [flushed, setFlushed] = useState(0);
	let [unanswered, setUnanswered] = useState<Record<string, Wire.Entry>>({});
	let [busy, setBusy] = useState(false);
	let [runs, setRuns] = useState<Wire.Runs>();
	let loadStages = useCallback(
		(runId: string, page: { offset: number; limit: number }, signal: AbortSignal) =>
			runStages(room, runId, page, signal),
		[room],
	);
	let [participation, setParticipation] = useState<{
		room: string;
		wire: Socket;
		state: Wire.Participation | undefined;
	}>();
	let [participationKey, setParticipationKey] = useState(0);
	let typing = useRef<TypingReporter | undefined>(undefined);
	let counts = runCounts(runs);
	// What the document's agent can be set to run, and what everyone in the room has set it to.
	let { control: modelControl, saved: modelSaved, unreadable: modelUnreadable } = useModelChoice({
		wire,
		room,
		connected,
		enabled: agent && !readonly && !archived,
	});
	// A refused choice, a choice the server could not read, or one the agent can no longer honour is
	// said until it is made again. One object while its words stand: the composer's strip eases in
	// and out as that value changes.
	let modelShown = composerModelNotice(modelControl, modelUnreadable, modelSaved);
	let modelWords = modelShown?.text;
	let modelTone = modelShown?.tone ?? "info";
	let modelNotice = useMemo<ComposerNotice | undefined>(
		() => modelWords ? { tone: modelTone, text: modelWords } : undefined,
		[modelWords, modelTone],
	);
	let [draft, setDraft] = useState<ComposerDraft>(() => restoreDraft(room, handle));
	let [submitting, setSubmitting] = useState(false);
	// A send pressed during a blip, made once the connection is back.
	let [held, setHeld] = useState(false);
	let sending = submitting || held;
	let [sendError, setSendError] = useState<SendFailure & { code?: string }>();
	let [researchBlock, setResearchBlock] = useState<ResearchLaunchBlock>();
	let researching = useRef(false);
	// Neither a research request the connection could not take nor a send it cut off outlives it.
	useEffect(() => {
		if (!connected) return;
		setResearchBlock(block => (block === "disconnected" ? undefined : block));
		setSendError(failure => failure?.lost ? undefined : failure);
	}, [connected]);
	let shownSend = shownSendFailure(sendError, connected, offline);
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
	// A reload must not take an unsent message with it. Kept as it changes
	// rather than on unload, which a browser does not promise to announce.
	useEffect(() => keepDraft(room, handle, draft), [room, handle, draft]);
	useEffect(() => keepOutbox(room, handle, outbox), [room, handle, outbox]);
	useEffect(() => keepRetractions(room, handle, retractions), [room, handle, retractions]);
	usePendingWork(
		!!draft.text.trim() || outbox.some(item => !item.acknowledged) || retractions.length > 0,
	);
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
	let reportTranscript = useRef(onTranscript);
	reportTranscript.current = onTranscript;
	useEffect(() => {
		reportTranscript.current?.({
			turn: turn?.id,
			messages: entries.length,
			current: transcriptReady,
		});
	}, [turn?.id, entries.length, transcriptReady]);
	// The document says when the connection is lost; Chat only holds back what it cannot send.
	let connectionNotice = useConnectionNotice(!connected, wire?.restarting);
	let quietRestart = useRef(false);
	quietRestart.current = silentRestart(
		quietRestart.current,
		!!wire?.restarting,
		transcriptReady,
		connectionNotice !== "none",
	);
	let [retried, setRetried] = useState<string>();
	let failed = failureBanner(entries, turn, handle);
	let sendBanner = shownSend ? sendFailureView(shownSend, shownSend.code) : undefined;
	let retryTurn = failed?.retry
		? () => {
			let payload = retryPayload(entries, failed.entry, () => crypto.randomUUID());
			if (!payload) return;
			setRetried(payload.requestId);
			dispatchOutbox({
				kind: "add",
				item: { payload, handle, ts: Math.floor(Date.now() / 1000) },
			});
		}
		: undefined;
	let retrying = !!retried
		&& outbox.some(item => item.payload.requestId === retried && !item.failure);
	useEffect(() => {
		if (retried && !retrying) setRetried(undefined);
	}, [retried, retrying]);
	// The failed reply whose banner has been drawn: a machine that drops after it did not cause it.
	let [shownFailure, setShownFailure] = useState<string>();
	// Only a banner that says why a send could not go gives a refused message's line its quiet;
	// a Planner's absence is another fact, and the message still says it was not sent.
	let quietFailures = !!banner && silencesFailedSends(banner.view);
	let composerReady = transcriptReady && !readonly && !archived;
	// What the composer and the empty transcript show. A restart is waited out in silence, and
	// nothing is to change on the page for it: until the fresh transcript is here they read as
	// they did, since the connection is the same Wire and what it last said is still true.
	let composerShown = (transcriptReady || quietRestart.current) && !readonly && !archived;
	let participationState = (transcriptReady || quietRestart.current) && participation?.room === room
			&& participation.wire === wire
		? participation.state
		: undefined;
	let typingEnabled = composerReady && active && agent && !!participationState?.enabled;
	// A message to the machine is kept in the outbox, so it needs neither the connection nor the
	// machine to be there when it is sent. Only a server that acknowledges sends can be asked to.
	let outboxed = agent && sendAcknowledgements;
	// A draft never waits on the connection; only sending does.
	let draftable = !readonly && !archived;
	let effectiveMode = !!agent && (mode || draft.submission?.to === "planner"
		|| addressedOutsideReferences(draft.text, draft.references));
	let plannerBound = outboxed && effectiveMode;
	let { working: workingTurn, suspended: suspendedWork } = progressOf(
		transcript,
		transcriptReady,
		quietRestart.current,
	);
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
				dispatchOutbox({
					kind: "history",
					ids: [...frame.entries.map(entry => entry.id), ...frame.queued.map(item => item.id)],
				});
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
				dispatchOutbox({ kind: "seen", ids: [frame.entry.id] });
				response(frame.entry.author.kind === "agent", frame.entry.text);
			}),
			wire.on<Wire.Removed>("chat:removed", frame => {
				dispatchTranscript({ kind: "removed", id: frame.id });
				dispatchOutbox({ kind: "drop", id: frame.id });
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
			wire.on<Wire.Queue>("chat:queue", frame => {
				setQueue(frame.waiting);
				dispatchOutbox({ kind: "seen", ids: frame.waiting.map(item => item.id) });
			}),
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
		if (outboxed) {
			let queued = prepareDraftSubmission(current, undefined, {
				planner: agent,
				mode: effectiveMode,
				referencesEnabled,
				focus,
			});
			if (queued?.submission.to === "planner") {
				// Never refused for the machine being away or the connection being down: it is in the
				// Chat at once and goes out by itself.
				dispatchOutbox({
					kind: "add",
					item: { payload: queued.submission, handle, ts: Math.floor(Date.now() / 1000) },
				});
				clearSubmittedDraft(current);
				restoreComposerFocus();
				return;
			}
		}
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
			// A restart cut the send off. The draft keeps its request id, so it is made again once
			// the server is back, and the server answers one it already holds with that message.
			if (error instanceof WireLost && error.restarting) setHeld(true);
			else {
				setSendError({
					...sendFailure(error),
					...(error instanceof WireRefusal && error.code ? { code: error.code } : {}),
				});
			}
		}).finally(() => {
			if (submission.current !== token) return;
			submission.current = undefined;
			setSubmitting(false);
			restoreComposerFocus();
		});
	};

	// The outbox goes out one message at a time, oldest first, once this connection's transcript is
	// here to say which of them the server already has. The request id makes a resend harmless.
	useEffect(() => {
		if (!wire || !transcriptReady || sendingId.current) return;
		let next = nextToSend(outbox);
		if (!next) return;
		let id = next.payload.requestId;
		sendingId.current = id;
		dispatchOutbox({ kind: "attempt", id });
		// Kept before it goes out, not after the next render: a reload in between must still know
		// that the server may hold it.
		keepOutbox(room, handle, outboxReducer(outbox, { kind: "attempt", id }));
		void wire.ask<Wire.Sent>("chat:send", next.payload).then(
			sent => dispatchOutbox({ kind: "acknowledge", id, entryId: sent?.id }),
			error => {
				// A lost connection leaves it for the next one; only a final refusal is final. A full
				// queue or a passing trouble is not a refusal of the message: it goes out again once
				// there may be room.
				if (!(error instanceof WireRefusal)) return;
				if (passing(error.code)) {
					dispatchOutbox({ kind: "full", id });
					setTimeout(() => dispatchOutbox({ kind: "room" }), FULL_RETRY_MS);
				} else {
					dispatchOutbox({ kind: "refuse", id, reason: refusalText(error.code, error.message) });
				}
			},
		).finally(() => {
			if (sendingId.current === id) sendingId.current = undefined;
			setFlushed(count => count + 1);
		});
	}, [wire, transcriptReady, outbox, flushed, room, handle]);

	// Messages taken back, which the server may hold or may still receive: it is told to drop each,
	// once there is a connection to tell it on, and again after a reload until it has answered.
	let asking = useRef(new Set<string>());
	let [askAgain, setAskAgain] = useState(0);
	useEffect(() => {
		if (!wire || !transcriptReady) return;
		for (let id of retractions) {
			if (asking.current.has(id)) continue;
			asking.current.add(id);
			void wire.ask<Wire.Deleted>("chat:delete", { id }).then(
				() => dispatchRetractions({ kind: "settled", id }),
				error => {
					// Only the server's last word ends it: the machine took the message meanwhile and it
					// is the server's now, with its new mark. A lost connection is asked again on the
					// next one; a refusal for a passing reason is asked again after a moment. Until then
					// the message stays hidden and is never delivered.
					if (!(error instanceof WireRefusal)) return;
					if (retractionSettledBy(error)) dispatchRetractions({ kind: "settled", id });
					else setTimeout(() => setAskAgain(count => count + 1), RETRACTION_RETRY_MS);
				},
			).finally(() => asking.current.delete(id));
		}
	}, [wire, transcriptReady, retractions, askAgain]);

	let deleteMessage = (id: string) => {
		let local = outbox.find(item => item.payload.requestId === id);
		if (local) {
			dispatchOutbox({ kind: "drop", id });
			// One put on the wire may be held by the server, which has to be told.
			let held = retractionFor(local);
			if (held) dispatchRetractions({ kind: "take-back", id: held });
			return;
		}
		// Gone from the Chat at once, and from everyone's when the server has done it.
		dispatchRetractions({ kind: "take-back", id });
	};
	let retryMessage = (id: string) => {
		if (outbox.some(item => item.payload.requestId === id)) dispatchOutbox({ kind: "again", id });
		else void wire?.ask<Wire.Retried>("chat:retry", { id }).catch(() => {});
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
		let timer = setTimeout(() => setHeld(false), connectionGrace(wire?.restarting));
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

	let bannerId = useId();
	let slot = bannerSlot(
		banner?.view,
		!!sendBanner,
		!!failed,
		!readonly && !archived,
		!!failed && shownFailure === failed.entry,
	);
	let leadNode = slot.lead === "send" && sendBanner
		? (
			<ErrorState
				id={bannerId}
				kind={sendBanner.kind}
				link={sendBanner.link}
				onRetry={sendBanner.retry ? submit : undefined}
				retryDisabled={!composerReady || submitting}
				title={sendBanner.title}
			/>
		)
		: slot.lead === "failure" && failed
		? (
			<ErrorState
				detail={failed.detail}
				id={bannerId}
				kind={failed.kind}
				link={failed.link}
				onRetry={retryTurn}
				retrying={retrying}
				title={failed.title}
			/>
		)
		: undefined;
	let drawnFailure = slot.lead === "failure" ? failed?.entry : undefined;
	useEffect(() => {
		if (drawnFailure) setShownFailure(drawnFailure);
	}, [drawnFailure]);
	let connectionId = `${bannerId}-connection`;
	let connectionNode = slot.connection && banner
		? <ConnectionBannerView id={connectionId} onRetry={banner.onRetry} view={banner.view} />
		: undefined;
	let bannerNode = leadNode || connectionNode
		? (
			<>
				{leadNode}
				{connectionNode}
			</>
		)
		: undefined;
	let bannerIds = [leadNode ? bannerId : undefined, connectionNode ? connectionId : undefined]
		.filter(Boolean).join(" ");
	// What waits for the Planner shows above the composer; a message in it is not in the transcript.
	let waiting = queueRows(queue, entries, handle).filter(row => !retractions.includes(row.id));
	let changeQueue = async (change: "cancel" | "edit", request: Promise<unknown>) => {
		try {
			await request;
			return undefined;
		} catch (error) {
			return refusalWords(change, error);
		}
	};

	let transcriptView = (
		<Transcript
			active={active}
			canEdit={composerShown}
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
			empty={transcriptReady && entries.length === 0 && waiting.length === 0 && outbox.length === 0
					&& !turn
				? emptyNotice
				: undefined}
			researchOffers={researchOffers}
			sourceDestination={sourceDestination}
			entries={[
				...withNoticesAfter(
					withoutFailure(
						withoutRetracted(entries, retractions),
						slot.lead === "failure" ? failed?.entry : undefined,
					),
					unanswered,
				),
				...echoes(outbox),
			]}
			hiddenQueued={new Set(queue.filter(item => item.kind === undefined).map(item => item.id))}
			onDelete={deleteMessage}
			onRetry={retryMessage}
			quietFailures={quietFailures}
			completedWork={transcript.completedWork}
			suspendedWork={suspendedWork}
			handle={handle}
			live={transcriptReady}
			working={workingTurn}
		/>
	);
	let queueView = (
		<MessageQueue
			onDelete={!readonly && !archived ? deleteMessage : undefined}
			onCancel={composerShown && wire
				? id => changeQueue("cancel", wire.ask<Wire.Unqueued>("chat:unqueue", { id }))
				: undefined}
			onEdit={composerShown && wire
				? (id, text) =>
					changeQueue(
						"edit",
						wire.ask<Wire.Edited>("chat:edit", { id, text }).then(saved => {
							setQueue(current =>
								current.map(item => {
									if (item.id !== id) return item;
									let { references: _, ...rest } = item;
									return {
										...rest,
										text: saved.text,
										...(saved.references ? { references: saved.references } : {}),
									};
								})
							);
						}),
					)
				: undefined}
			queued={waiting}
			started={new Set(
				entries.filter(entry => entry.deliveryState !== "sent").map(entry => entry.id),
			)}
			restoreFocus={() => textarea.current?.focus()}
		/>
	);
	if (notice) {
		return (
			<div className="flex h-full min-h-0 flex-col">
				{transcriptView}
				{queueView}
				<div className="chat-composer shrink-0 px-2.5 pb-2.5">
					<p className="px-4 py-3 text-sm text-text-tertiary">{notice}</p>
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
						loadStages={loadStages}
						offline={offline}
						onPause={runId =>
							wire?.send("chat:pause-run", { runId })}
						onResume={runId =>
							wire?.send("chat:resume-run", { runId })}
						onShowDecisions={onShowDecisions}
						runs={runs}
					/>
				</div>
			)}

			{queueView}

			<ChatComposer
				rootRef={composerRoot}
				inputRef={textarea}
				agent={!!agent}
				model={modelControl}
				mode={{
					chopin: effectiveMode,
					disabled: !draftable || sending || !agent,
					onToggle: toggleMode,
				}}
				banner={bannerNode
					? { id: bannerIds, node: bannerNode, invalid: slot.lead === "send" }
					: undefined}
				notice={slot.quietsNotices
					? undefined
					: researchBlock && !(offline && researchBlock === "disconnected")
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
					? repliesOffNotice(offline)
					: modelNotice}
				unavailable={archived ? "archived" : readonly ? "readonly" : undefined}
				references={referencesEnabled
					? {
						disabled: !composerShown || submitting,
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
					|| (connectionNotice !== "none" && !draftCommand(draft.text) && !plannerBound)}
				onSubmit={submit}
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
