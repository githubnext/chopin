/**
 * The chat pane.
 *
 * Drives the agent, and shows what it is doing. The composer stays live while
 * a turn runs — a turn owns the plan, not the chat — and anything sent
 * meanwhile is posted at once, with its author's name on it, so nobody is
 * silenced because a colleague prompted first.
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
import { canWithdraw } from "./withdraw";
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
import { applyFormat } from "./format-markdown";
import { keepFormatPreference, readFormatPreference } from "./format-preference";
import type { Format } from "./format-markdown";
import { bannerSlot } from "./banner-slot";
import { ConnectionBannerView } from "./connection-banner";
import type { ConnectionBanner, TranscriptFacts } from "./connection-banner";
import { silencesFailedSends } from "./connection-phase";
import { ErrorState } from "./error-state";
import { failureBanner, retryPayload, sendFailureView, withoutFailure } from "./failure";
import { TypingReporter } from "./typing";
import {
	asksChopin,
	chipKeyAction,
	chipShown,
	restoredChip,
	takeChopinMention,
	withoutChopinMentions,
} from "./chopin-chip";
import { ChatComposer } from "./composer";
import type { ComposerNotice } from "./composer";

import { CommandPicker } from "./command-picker";
import {
	CHAT_COMMANDS,
	commandBrief,
	commandKeyAction,
	commandList,
	commandText,
	commandTrigger,
	commandTriggerKey,
	draftCommand,
	filterCommands,
} from "./commands";
import { MentionPicker, mentionRows } from "./mention-picker";
import { pointerGroups, useMentionSources } from "./mention-sources";
import type { PointerOption } from "./mention-sources";
import { modelReadsImages } from "@chopin/protocol/model-choice";
import { useFiles } from "./attachments/use-files";
import { dictationSource, useDictation } from "./dictation/use-dictation";
import { currentShortcutPlatform, shortcutLabel } from "../shortcuts";
import { composerModelNotice } from "./model-picker-state";
import { useModelChoice } from "./use-model-choice";
import {
	chatAuthors,
	filterMentions,
	insertMention,
	mentionCandidates,
	mentionKeyAction,
	mentionTriggerKey,
	pointerTrigger,
} from "./mentions";
import {
	referenceOptionId,
	ReferencePicker,
	referencePickerKeyAction,
	useReferencePicker,
} from "./reference-picker";
import {
	acknowledgeDraft,
	addressesPlanner,
	insertCommand,
	insertPointer,
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
	runsCommand,
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

import type { Chat as Wire, ConversationPlan, Session } from "@chopin/protocol";
import type { Repository } from "../api";
import type { ResearchLaunchBlock, ResearchLaunchResult } from "@chopin/editor";
import type { ChatCommand } from "./commands";
import type { MentionRow } from "./mention-picker";
import type { MentionCandidate } from "./mentions";
import type { ChatSendPayload, ComposerDraft, ReferenceTarget, SendFailure } from "./references";
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
	/** The caps on the images and files a message may carry; absent where the server takes none. */
	attachments?: Session.AttachmentSettings;
	/** Set where the deployment turns recordings into words, naming who does it. */
	transcription?: { provider: string };
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
		attachments,
		transcription,
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
	let {
		control: modelControl,
		saved: modelSaved,
		savedName: modelSavedName,
		unreadable: modelUnreadable,
		commands: agentCommands,
	} = useModelChoice({
		wire,
		room,
		connected,
		enabled: agent && !readonly && !archived,
	});
	// A refused or unreadable choice has its own notice. A fallback is shown only until the
	// transcript records it. One object while its words stand keeps the composer's transition stable.
	let modelShown = composerModelNotice(
		modelControl,
		modelUnreadable,
		modelSaved,
		entries,
		modelSavedName,
	);
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
	// A send pressed while files are still uploading, made once they have.
	let [awaiting, setAwaiting] = useState(false);
	let awaitingFiles = useRef(false);
	let sending = submitting || held || awaiting;
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
	// The chip at the start of the draft, which is who the message is for. It stays on after Chopin
	// is asked, until it is removed.
	let [chipOn, setChipOn] = useState(() => restoredChip(draft, draft.submission?.to));
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
	let chip = chipShown({
		agent: !!agent,
		chip: chipOn,
		text: draft.text,
		references: draft.references,
		submitted: draft.submission?.to,
	});
	let commandDraft = runsCommand(draft.references);
	let askingChopin = asksChopin({
		agent: !!agent,
		chip: chipOn,
		text: draft.text,
		references: draft.references,
		submitted: draft.submission?.to,
	});
	let plannerBound = outboxed && askingChopin;
	// An image goes where people read it, and to the Planner only if its model does.
	let imagesAllowed = !agent || !askingChopin
		|| modelReadsImages(modelControl?.catalog, modelControl?.choice);
	let files = useFiles({ channelId: room, limits: attachments, imagesAllowed });
	let filesRef = useRef(files);
	filesRef.current = files;
	// Another set of files is another message: its request id is made again.
	let filesKey = files.files.map(file => file.sent?.id ?? "").join();
	let filesSeen = useRef(filesKey);
	useEffect(() => {
		if (filesSeen.current === filesKey) return;
		filesSeen.current = filesKey;
		setDraft(current =>
			current.submission ? { text: current.text, references: current.references } : current
		);
	}, [filesKey]);
	let submitAgain = useRef<() => void>(() => {});
	let selectionRef = useRef(selection);
	selectionRef.current = selection;
	// Speech becomes words in the draft at the caret: the draft is ordinary text and stays editable.
	let dictation = useDictation({
		source: useMemo(
			() =>
				typeof window === "undefined"
					? undefined
					: dictationSource(window, navigator.mediaDevices, transcription),
			[transcription?.provider],
		),
		room,
		lang: typeof navigator === "undefined" ? "en-US" : navigator.language || "en-US",
		read: () => ({ text: draftRef.current.text, caret: selectionRef.current.start }),
		write: (text, caret, from) => {
			let revised = reviseComposerDraft(
				draftRef.current,
				text,
				reconcileReferenceDrafts(draftRef.current.text, text, draftRef.current.references, {
					start: from,
					end: from,
				}),
			);
			draftRef.current = revised;
			selectionRef.current = { start: caret, end: caret };
			setDraft(revised);
			setSelection({ start: caret, end: caret });
			setSendError(undefined);
			pendingCaret.current = caret;
		},
	});
	let dictationRef = useRef(dictation);
	dictationRef.current = dictation;
	// A composer that can no longer take words stops listening for them.
	useEffect(() => {
		if (!draftable) dictationRef.current?.stop();
	}, [draftable]);
	usePendingWork(
		!!draft.text.trim() || files.files.length > 0 || outbox.some(item => !item.acknowledged)
			|| retractions.length > 0,
	);
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
		? pointerTrigger(draft.text, selection.start, selection.end)
		: undefined;
	let mentionKey = mention ? mentionTriggerKey(mention) : undefined;
	let freeMention = mention
			&& !draft.references.some(reference =>
				reference.start < mention.end && reference.end > mention.start
			)
		? mention
		: undefined;
	let mentionOptions = freeMention
		? filterMentions(
			mentionCandidates({ authors, people, planner: agent, self: handle }),
			freeMention.query,
		)
		: [];
	// The document's parts and files are asked for as the person types, while the menu can show.
	let sources = useMentionSources(
		room,
		referencesEnabled && freeMention && mentionKey !== dismissedPicker
			? freeMention.query
			: undefined,
	);
	let mentionRowsShown = mentionRows(
		mentionOptions,
		atReferenceLimit ? [] : pointerGroups(sources),
	);
	let mentionOpen = mentionRowsShown.length > 0 && mentionKey !== dismissedPicker;
	let mentionActive = mentionCursor.key === mentionKey
		? Math.min(mentionCursor.index, mentionRowsShown.length - 1)
		: 0;
	let activeMention: MentionRow | undefined = mentionOpen
		? mentionRowsShown[mentionActive]
		: undefined;
	let command = composerReady && !submitting
		? commandTrigger(draft.text, selection.start, selection.end)
		: undefined;
	let commandKey = command ? commandTriggerKey(command) : undefined;
	// Chat's own commands, and the agent's for a person who can send to it.
	let commandPool = commandList(
		onResearch ? CHAT_COMMANDS : [],
		agent && composerReady ? agentCommands : undefined,
	);
	let commandOptions = command ? filterCommands(commandPool, command.query) : [];
	let commandOpen = commandOptions.length > 0 && commandKey !== dismissedPicker;
	let commandActive = commandCursor.key === commandKey
		? Math.min(commandCursor.index, commandOptions.length - 1)
		: 0;
	// Without research here, a `/research` draft is held with a notice rather than posted.
	let blockedCommand = !onResearch && !commandDraft && !!draftCommand(draft.text);
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
		if (submission.current || !draftable || awaitingFiles.current) return;
		typing.current?.stop();
		// What was being said is sent as it was shown, and listening ends.
		let spoken = dictationRef.current?.settle(draftRef.current.text);
		if (spoken && spoken.text !== draftRef.current.text) {
			let revised = reviseComposerDraft(
				draftRef.current,
				spoken.text,
				reconcileReferenceDrafts(draftRef.current.text, spoken.text, draftRef.current.references, {
					start: spoken.at,
					end: spoken.at,
				}),
			);
			draftRef.current = revised;
			setDraft(revised);
		}
		let current = draftRef.current;
		if (!runsCommand(current.references) && draftCommand(current.text)) {
			// `#` references stay in the brief as their visible titles.
			launchResearch(commandBrief(current.text));
			return;
		}
		let hasFiles = files.files.length > 0;
		if (!current.text.trim() && !hasFiles) return;
		if (hasFiles) {
			// A file that did not go is for the person to remove or send again, not to leave behind.
			if (files.failed > 0) return;
			if (files.uploading > 0) {
				// The message waits for its files and goes as it was pressed; if one fails it stays here.
				awaitingFiles.current = true;
				setAwaiting(true);
				void files.settled().then(result => {
					awaitingFiles.current = false;
					setAwaiting(false);
					if (result.ok) submitAgain.current();
				});
				return;
			}
		}
		let sentIds = files.ids();
		let sentFiles = files.sent();
		let withFiles = (payload: ChatSendPayload): ChatSendPayload =>
			sentIds.length ? { ...payload, attachments: sentIds } : payload;
		if (outboxed) {
			let queued = prepareDraftSubmission(current, undefined, {
				planner: agent,
				asking: chip,
				referencesEnabled,
				focus,
				files: hasFiles,
			});
			if (queued?.submission.to === "planner") {
				// Never refused for the machine being away or the connection being down: it is in the
				// Chat at once and goes out by itself.
				dispatchOutbox({
					kind: "add",
					item: {
						payload: withFiles(queued.submission),
						handle,
						ts: Math.floor(Date.now() / 1000),
						...(sentFiles.length ? { attachments: sentFiles } : {}),
					},
				});
				clearSubmittedDraft(current);
				files.clear();
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
			asking: chip,
			referencesEnabled,
			focus,
			files: hasFiles,
		});
		if (!submitted) return;
		let payload = withFiles(submitted.submission);
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
			files.clear();
			submission.current = undefined;
			setSubmitting(false);
			restoreComposerFocus();
			return;
		}
		void wire.ask<Wire.Sent>("chat:send", payload).then(() => {
			clearSubmittedDraft(submitted);
			files.clear();
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

	submitAgain.current = submit;

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

	// The formatting toolbar above the draft, which each person turns on or off for themselves.
	let [formatting, setFormatting] = useState(() => readFormatPreference(handle));
	let toggleFormatting = () => {
		keepFormatPreference(handle, !formatting);
		setFormatting(on => !on);
	};
	// A mark is inserted into the draft's text as Markdown, round the selection, and what it
	// replaced is told so that the references outside it are kept.
	let formatDraft = (kind: Format) => {
		let current = draftRef.current;
		let result = applyFormat(kind, current.text, selection);
		setDraft(
			reviseComposerDraft(
				current,
				result.text,
				reconcileReferenceDrafts(current.text, result.text, current.references, result.edit),
			),
		);
		setSelection({ start: result.start, end: result.end });
		setSendError(undefined);
		pendingCaret.current = { start: result.start, end: result.end };
	};
	// An `@` at the caret, which opens the mentions.
	let startMention = () => {
		let current = draftRef.current;
		let before = current.text.slice(0, selection.start);
		let lead = before && !/\s$/.test(before) ? " @" : "@";
		let next = before + lead + current.text.slice(selection.end);
		let caret = before.length + lead.length;
		setDraft(
			reviseComposerDraft(
				current,
				next,
				reconcileReferenceDrafts(current.text, next, current.references, selection),
			),
		);
		setSelection({ start: caret, end: caret });
		setSendError(undefined);
		setDismissedPicker(undefined);
		pendingCaret.current = caret;
	};

	// Puts the chip on or takes it off. Taking it off also takes out any @chopin typed in the words,
	// or the message would still ask Chopin and the chip would come straight back. A send prepared
	// for the other audience is not the one to make now, so the draft is made again when it goes.
	let setChip = (on: boolean) => {
		if (!draftable || sending || !agent || chip === on) return;
		let current = draftRef.current;
		setChipOn(on);
		let next = on
			? { text: current.text, references: current.references, ...selection }
			: withoutChopinMentions(current.text, current.references, selection);
		setDraft({ text: next.text, references: next.references });
		setSelection({ start: next.start, end: next.end });
		setSendError(undefined);
		setDismissedPicker(triggerKey ?? mentionKey);
		pendingCaret.current = { start: next.start, end: next.end };
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
		if (!freeMention) return;
		if (candidate.kind === "planner") {
			// Chopin is the chip, not words in the draft.
			let taken = takeChopinMention(draft.text, draft.references, freeMention);
			setChipOn(true);
			setDraft({ text: taken.text, references: taken.references });
			setSelection({ start: taken.caret, end: taken.caret });
			setSendError(undefined);
			setDismissedPicker(undefined);
			pendingCaret.current = taken.caret;
			return;
		}
		let next = insertMention(draft.text, freeMention, candidate);
		setDraft(current =>
			reviseComposerDraft(
				current,
				next.text,
				reconcileReferenceDrafts(
					current.text,
					next.text,
					current.references,
					{ start: freeMention.start, end: freeMention.end },
				),
			)
		);
		setSelection({ start: next.caret, end: next.caret });
		setSendError(undefined);
		setDismissedPicker(undefined);
		pendingCaret.current = next.caret;
	};

	/** A part of the document or a file becomes a chip, which the Planner receives as what it is. */
	let choosePointer = (option: PointerOption) => {
		if (!freeMention) return;
		let next = insertPointer(draft.text, draft.references, freeMention, option);
		setDraft(current => reviseComposerDraft(current, next.text, next.references));
		setSelection({ start: next.caret, end: next.caret });
		setSendError(undefined);
		setDismissedPicker(undefined);
		pendingCaret.current = next.caret;
	};

	let chooseRow = (row: MentionRow) =>
		row.type === "candidate" ? chooseMention(row.candidate) : choosePointer(row.option);

	let moveMention = (to: (index: number) => number) =>
		setMentionCursor({ key: mentionKey, index: to(mentionActive) });

	let chooseCommand = (choice: ChatCommand) => {
		if (choice.source === "chat") {
			launchResearch("", commandText(choice));
			return;
		}
		// The agent's command opens the draft as a chip, and the person goes on with its words.
		if (!command) return;
		let next = insertCommand(draft.text, draft.references, command, {
			name: choice.name,
			commandKind: choice.commandKind ?? "",
		});
		setDraft(current => reviseComposerDraft(current, next.text, next.references));
		setSelection({ start: next.caret, end: next.caret });
		setSendError(undefined);
		setDismissedPicker(undefined);
		pendingCaret.current = next.caret;
	};

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
			empty={transcriptReady && entries.length === 0 && queue.length === 0 && outbox.length === 0
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
			onDelete={deleteMessage}
			onRetry={retryMessage}
			quietFailures={quietFailures}
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

			<ChatComposer
				rootRef={composerRoot}
				inputRef={textarea}
				agent={!!agent}
				model={modelControl}
				chopin={agent
					? {
						chip,
						disabled: !draftable || sending,
						onAdd: () => setChip(true),
						onRemove: () => setChip(false),
					}
					: undefined}
				banner={bannerNode
					? { id: bannerIds, node: bannerNode, invalid: slot.lead === "send" }
					: undefined}
				notice={slot.quietsNotices
					? undefined
					// Why dictation stopped without finishing, in the composer's own strip, until it is dismissed.
					: dictation?.failure
					? {
						tone: "warning",
						text: dictation.failure,
						action: { label: "Dismiss", onClick: dictation.dismiss },
					}
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
				format={{
					shown: formatting,
					disabled: !composerShown || submitting,
					onToggle: toggleFormatting,
					onFormat: formatDraft,
				}}
				mention={{ disabled: !composerShown || submitting, onMention: startMention }}
				files={attachments
					? {
						files: files.files,
						source: files.source,
						...(!imagesAllowed && agent
							? {
								imagesReason: "This model can't read images, so only text files can be sent to it.",
							}
							: {}),
						disabled: !draftable || sending,
						waiting: awaiting,
						onAdd: files.add,
						onRemove: files.remove,
						onRetry: files.retry,
					}
					: undefined}
				dictation={dictation
					? {
						active: dictation.active,
						phase: dictation.phase,
						seconds: dictation.seconds,
						announcement: dictation.announcement,
						disabled: !draftable || sending,
						onToggle: dictation.toggle,
						tooltip: `${dictation.active ? "Stop dictating" : "Dictate"} (${
							shortcutLabel("dictate", currentShortcutPlatform())
						}). ${
							dictation.source === "browser"
								? "Speech is turned into words on this device."
								: `Your recording is sent to ${transcription?.provider} to be turned into words.`
						}`,
					}
					: undefined}
				draftable={draftable}
				sending={sending}
				sendDisabled={!draftable || sending || (!draft.text.trim() && files.files.length === 0)
					|| files.failed > 0
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
								groups={atReferenceLimit ? [] : pointerGroups(sources)}
								id={mentionPickerId}
								onActive={index => setMentionCursor({ key: mentionKey, index })}
								onSelect={chooseMention}
								onSelectPointer={choosePointer}
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
						dictation?.follow(event.currentTarget.selectionStart);
					},
					onBlur: () => typing.current?.stop(),
					interim: dictation?.interim,
					onKeyDown: event => {
						let composing = event.nativeEvent.isComposing || event.keyCode === 229;
						let chipAction = agent && draftable && !sending
							? chipKeyAction({
								key: event.key,
								keyCode: event.keyCode,
								isComposing: event.nativeEvent.isComposing,
								shiftKey: event.shiftKey,
								altKey: event.altKey,
								ctrlKey: event.ctrlKey,
								metaKey: event.metaKey,
							}, {
								chip,
								selectionStart: textarea.current?.selectionStart ?? 0,
								selectionEnd: textarea.current?.selectionEnd ?? 0,
							})
							: undefined;
						if (chipAction) {
							event.preventDefault();
							if (!event.repeat) setChip(chipAction === "insert");
							return;
						}
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
							moveMention(index => (index + 1) % mentionRowsShown.length);
							event.preventDefault();
							return;
						}
						if (mentionAction === "previous") {
							moveMention(index => (index - 1 + mentionRowsShown.length) % mentionRowsShown.length);
							event.preventDefault();
							return;
						}
						if (mentionAction === "select" && activeMention) {
							chooseRow(activeMention);
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
					onSelect: event => {
						setSelection({
							start: event.currentTarget.selectionStart,
							end: event.currentTarget.selectionEnd,
						});
						dictation?.follow(event.currentTarget.selectionStart);
					},
					value: draft.text,
				}}
			/>
		</div>
	);
}
