/**
 * The chat pane.
 *
 * Drives the agent, and shows what it is doing. The composer stays live while
 * a turn runs — a turn owns the plan, not the chat — and anything sent
 * to the agent meanwhile is queued in order, with its author's name on it, so
 * nobody is silenced because a colleague prompted first.
 */

import { useEffect, useId, useLayoutEffect, useReducer, useRef, useState } from "react";

import { SendAction, usePopoverDismissal } from "@chopin/editor";
import { MENTION } from "@chopin/protocol/address";
import { ArchiveIcon, InfoIcon, LoaderIcon, LockIcon, PlusIcon, WarningIcon } from "@chopin/icons";
import { DraftInput } from "./draft-input";
import type { DraftInputHandle } from "./draft-input";
import { ModeSwitch } from "./mode-switch";
import "./composer.css";

import { CommandPicker } from "./command-picker";
import {
	CHAT_COMMANDS,
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
	chatSendPayload,
	insertReference,
	MAX_REFERENCES,
	PLANNER_UNAVAILABLE_NOTICE,
	prepareDraftSubmission,
	reconcileReferenceDrafts,
	referenceTrigger,
	referenceTriggerKey,
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
import plannerStop from "../assets/icons/planner-stop.svg";
import plannerResume from "../assets/icons/planner-resume.svg";

import type { Chat as Wire, ConversationPlan } from "@chopin/protocol";
import type { Repository } from "../api";
import type { ChatCommand } from "./commands";
import type { MentionCandidate } from "./mentions";
import type { ComposerDraft, ReferenceTarget } from "./references";
import type { Wire as Socket } from "../wire";

export type ChatProps = {
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
	onActivity?: (event: { type: "message" | "working"; busy: boolean }) => void;
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
	/** Whether this document can start research, which happens in the document itself. */
	research?: boolean;
	/** Puts the caret at the end of the document. */
	onOpenDocument?: () => void;
	/** Replaces the composer when this viewer cannot chat at all, such as in an archived document. */
	notice?: string;
	/** One calm line shown while the transcript has loaded and is still empty. */
	emptyNotice?: string;
};

/** How many runs are still live, and how many are paused and resumable. */
export function runCounts(runs: Wire.Runs | undefined): { active: number; paused: number } {
	let list = runs ?? [];
	return {
		active: list.filter(run => run.status === "running" || run.status === "waiting").length,
		paused: list.filter(run => run.status === "paused").length,
	};
}

export function Chat(
	{
		active = true,
		agent = true,
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
		onShowDecisions,
		research = false,
		onOpenDocument,
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
	let counts = runCounts(runs);
	let [draft, setDraft] = useState<ComposerDraft>({
		text: "",
		references: [],
	});
	let [submitting, setSubmitting] = useState(false);
	let [sendError, setSendError] = useState<string>();
	let [selection, setSelection] = useState({ start: 0, end: 0 });
	let [dismissedPicker, setDismissedPicker] = useState<string>();
	let [mentionCursor, setMentionCursor] = useState<{ key?: string; index: number }>({ index: 0 });
	let [commandCursor, setCommandCursor] = useState<{ key?: string; index: number }>({ index: 0 });
	let textarea = useRef<DraftInputHandle>(null);
	let composerRoot = useRef<HTMLDivElement>(null);
	let [mode, setMode] = useState(false);
	let [historyKey, setHistoryKey] = useState(0);
	let pendingCaret = useRef<number | { start: number; end: number } | undefined>(undefined);
	let submission = useRef<object | undefined>(undefined);
	let draftRef = useRef(draft);
	draftRef.current = draft;
	let pickerId = useId();
	let mentionPickerId = useId();
	let commandPickerId = useId();
	let instructionsId = useId();
	let cueId = useId();
	let synchronized = useRef<Socket | undefined>(undefined);
	let activity = useRef(onActivity);
	let reportedBusy = useRef(false);
	activity.current = onActivity;
	// A socket opens before its fresh transcript arrives, and reconnects reuse
	// the same Wire. Only that transcript makes this composer current.
	if (!connected) synchronized.current = undefined;
	let transcriptReady = connected && synchronized.current === wire;
	let composerReady = transcriptReady && !readonly && !archived;
	let connectionLost = !connected && ["reconnecting", "closed"].includes(wire?.status ?? "");
	let effectiveMode = agent && (mode || addressedOutsideReferences(draft.text, draft.references));
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
	let commandOptions = command && research ? filterCommands(CHAT_COMMANDS, command.query) : [];
	let commandOpen = commandOptions.length > 0 && commandKey !== dismissedPicker;
	let commandActive = commandCursor.key === commandKey
		? Math.min(commandCursor.index, commandOptions.length - 1)
		: 0;
	let pendingCommand = draftCommand(draft.text);
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
				// History is not unread, but a turn already in progress still needs
				// a signal outside a closed Chat destination.
				activity.current?.({ type: "working", busy: frame.busy });
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
		];

		return () => {
			for (let unsubscribe of off) unsubscribe();
		};
	}, [wire]);

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

	let submit = () => {
		if (submission.current || !composerReady || !wire) return;
		let current = draftRef.current;
		if (!current.text.trim() || draftCommand(current.text)) return;
		let submitted = prepareDraftSubmission(current);
		let prefix = effectiveMode && !addressedOutsideReferences(submitted.text, submitted.references)
			? `${MENTION} `
			: "";
		let payload = chatSendPayload(
			prefix + submitted.text,
			submitted.references.map(reference => ({
				...reference,
				start: reference.start + prefix.length,
				end: reference.end + prefix.length,
			})),
			agent,
			submitted.requestId,
			referencesEnabled,
		);
		if (!payload) return;
		let token = {};
		submission.current = token;
		draftRef.current = submitted;
		setDraft(submitted);
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

	let toggleMode = () => {
		if (!composerReady || submitting || !agent) return;
		let current = draftRef.current;
		let at = selection.start;
		let end = selection.end;
		if (effectiveMode) {
			let removals = [...current.text.matchAll(/(^|[^\w@])@chopin\b/gi)]
				.map(match => ({
					start: match.index + match[1]!.length,
					end: match.index + match[0].length,
				}))
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

	let chooseCommand = (choice: ChatCommand) => {
		let next = commandText(choice);
		setDraft(current => reviseComposerDraft(current, next, []));
		setSelection({ start: next.length, end: next.length });
		setSendError(undefined);
		setDismissedPicker(undefined);
		pendingCaret.current = next.length;
	};

	let openDocument = () => {
		let current = draftRef.current;
		// A bare command has nothing worth keeping; a typed brief stays for copying.
		if (current.text.trim().toLowerCase() === "/research") {
			setDraft(reviseComposerDraft(current, "", []));
			setSelection({ start: 0, end: 0 });
		}
		onOpenDocument?.();
	};

	let transcriptView = (
		<Transcript
			active={active}
			canEdit={composerReady}
			conversationPlanJobs={conversationPlanJobs}
			onCardLink={onCardLink}
			onAddExcerpt={onAddExcerpt}
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
			onWithdraw={id => wire?.send("chat:unqueue", { id })}
			queued={queue}
			talkingToChopin={mode}
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
						onPause={runId =>
							wire?.send("chat:pause-run", { runId })}
						onResume={runId =>
							wire?.send("chat:resume-run", { runId })}
						onShowDecisions={onShowDecisions}
						runs={runs}
					/>
				</div>
			)}

			<div ref={composerRoot} className="chat-composer relative shrink-0 px-2.5 pb-2.5">
				{referencesEnabled && (
					<p className="sr-only" id={instructionsId}>
						Type # to reference a document.
					</p>
				)}
				{!readonly && !archived && (sendError || !composerReady || pendingCommand || !agent) && (
					<div
						className={sendError ? "composer-notice motion-feedback" : "composer-notice"}
						data-motion-feedback={sendError ? "alert" : undefined}
						role={sendError ? "alert" : "status"}
						data-error={!!sendError || undefined}
						id={cueId}
					>
						{sendError
							? <WarningIcon className="icon-danger" size={14} />
							: connectionLost
							? <WarningIcon size={14} />
							: !composerReady
							? <LoaderIcon className="chat-tool-loader" size={14} />
							: <InfoIcon size={14} />}
						<span>
							{sendError ?? (!composerReady
								? connected ? "Synchronizing…" : connectionLost ? "Connection lost" : "Connecting…"
								: pendingCommand
								? research
									? "Use /research in the document"
									: "Research isn’t available in this document"
								: "Chopin unavailable")}
						</span>
						{sendError
							? (
								<button
									className="btn btn-sm btn-outline-danger"
									disabled={!composerReady || submitting}
									onClick={submit}
								>
									Retry
								</button>
							)
							: !composerReady
							? wire && (
								<button
									className="btn btn-sm btn-ghost"
									onClick={() => wire.reconnect()}
								>
									{connectionLost ? "Reconnect" : "Retry"}
								</button>
							)
							: pendingCommand && research && onOpenDocument && (
								<button className="btn btn-sm btn-ghost" onClick={openDocument} type="button">
									Go to document
								</button>
							)}
					</div>
				)}
				<div
					aria-busy={submitting}
					className="composer-surface field"
					data-mode={effectiveMode ? "chopin" : "chat"}
					data-error={!!sendError || undefined}
				>
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
					{readonly || archived
						? (
							<div className="composer-unavailable" role="status">
								{archived ? <ArchiveIcon size={18} /> : <LockIcon size={18} />}
								<strong>{archived ? "Document archived" : "Read-only access"}</strong>
								<p>
									{archived
										? "Restore this document to send messages."
										: "You need write access to send messages."}
								</p>
							</div>
						)
						: (
							<>
								<DraftInput
									aria-label="Message"
									aria-activedescendant={commandOpen
										? referenceOptionId(commandPickerId, commandActive)
										: mentionOpen
										? referenceOptionId(mentionPickerId, mentionActive)
										: pickerOpen && activeOption
										? referenceOptionId(pickerId, picker.options.indexOf(activeOption))
										: undefined}
									aria-autocomplete="list"
									aria-controls={commandOpen
										? commandPickerId
										: mentionOpen
										? mentionPickerId
										: pickerOpen
										? pickerId
										: undefined}
									aria-describedby={[
										referencesEnabled ? instructionsId : undefined,
										sendError || !composerReady || pendingCommand || !agent ? cueId : undefined,
									].filter(Boolean).join(" ") || undefined}
									aria-disabled={!composerReady || submitting}
									aria-invalid={!!sendError || undefined}
									aria-expanded={commandOpen || pickerOpen || mentionOpen}
									readOnly={!composerReady || submitting}
									role="combobox"
									resetKey={historyKey}
									historyGroupKey={mode}
									onSubmit={submit}
									references={draft.references}
									mentions={[
										handle,
										...mentionCandidates({ authors, people, planner: agent, self: handle }).map(
											candidate => candidate.login,
										),
									]}
									onChange={event => {
										let next = event.currentTarget.value;
										setDraft(current =>
											reviseComposerDraft(
												current,
												next,
												event.currentTarget.references
													?? reconcileReferenceDrafts(current.text, next, current.references),
											)
										);
										setSendError(undefined);
										setDismissedPicker(undefined);
										setSelection({
											start: event.currentTarget.selectionStart,
											end: event.currentTarget.selectionEnd,
										});
									}}
									onKeyDown={event => {
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
											&& !event.ctrlKey && !event.altKey && agent && composerReady && !submitting
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
											moveMention(index =>
												(index - 1 + mentionOptions.length) % mentionOptions.length
											);
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
									}}
									onSelect={event =>
										setSelection({
											start: event.currentTarget.selectionStart,
											end: event.currentTarget.selectionEnd,
										})}
									placeholder={effectiveMode ? "Ask Chopin…" : "Message your collaborators…"}
									ref={textarea}
									value={draft.text}
								/>

								<div className="composer-footer">
									<div className="composer-left">
										<ModeSwitch
											effectiveMode={effectiveMode}
											disabled={!composerReady || submitting || !agent}
											onToggle={toggleMode}
										/>

										{referencesEnabled && (
											<button
												type="button"
												className="btn btn-icon btn-ghost"
												aria-label="Mention docs"
												title="Mention docs"
												data-tooltip="Mention docs"
												data-tooltip-verbatim=""
												disabled={!composerReady || submitting}
												onClick={() => {
													let current = draftRef.current;
													let next = current.text
														+ (current.text && !current.text.endsWith(" ") ? " #" : "#");
													setDraft(reviseComposerDraft(current, next, current.references));
													setSelection({ start: next.length, end: next.length });
													setDismissedPicker(undefined);
													pendingCaret.current = next.length;
												}}
											>
												<PlusIcon size={14} />
											</button>
										)}
									</div>
									<div className="composer-actions">
										<span className="composer-run-control">
											{agent && (busy || counts.active > 0) && (
												<button
													aria-label="Stop Chopin"
													disabled={!composerReady}
													className="btn btn-icon btn-secondary"
													onClick={() => wire?.send("chat:abort")}
													title="Stop Chopin"
													type="button"
												>
													<img alt="" className="size-[14px]" src={plannerStop} />
												</button>
											)}
											{agent && !busy && !counts.active && counts.paused > 0 && (
												<button
													aria-label="Resume Chopin"
													disabled={!composerReady}
													className="btn btn-icon btn-secondary"
													onClick={() => wire?.send("chat:resume")}
													title="Resume Chopin"
													type="button"
												>
													<img alt="" className="size-[14px]" src={plannerResume} />
												</button>
											)}
										</span>
										<SendAction
											busy={submitting}
											disabled={!composerReady || submitting || !draft.text.trim()
												|| !!pendingCommand}
											onClick={submit}
											label="Send message"
										/>
									</div>
								</div>
							</>
						)}
				</div>
			</div>
		</div>
	);
}
