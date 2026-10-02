/**
 * The chat pane.
 *
 * Drives the agent, and shows what it is doing. The composer stays live while
 * a turn runs — a turn owns the plan, not the chat — and anything sent
 * to the agent meanwhile is queued in order, with its author's name on it, so
 * nobody is silenced because a colleague prompted first.
 *
 * The agent only acts when addressed, so one Send action can follow the
 * message's own signal rather than asking its author to select a destination.
 */

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";

import { SendAction } from "@chopin/editor";
import { MENTION } from "@chopin/protocol/address";

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
	beforeInputSelection,
	boundedChatError,
	chatSendPayload,
	insertReference,
	MAX_REFERENCES,
	prepareDraftSubmission,
	reconcileReferenceDrafts,
	referenceTrigger,
	referenceTriggerKey,
	reviseComposerDraft,
} from "./references";
import { Transcript } from "./transcript";
import type { TranscriptDecisions } from "./transcript";
import type { CardLink } from "../conversation-plan/links";
import type { ExcerptCorrectionAction } from "../conversation-plan/analysis-overview";
import type { ChatDestination } from "../conversation-plan/source";
import type { ResearchOfferControls } from "./research-offer";
import { TerminalAlert } from "../terminal-alert";
import plannerStop from "../assets/icons/planner-stop.svg";

import type { Chat as Wire, ConversationPlan } from "@chopin/protocol";
import type { Repository } from "../api";
import type { MentionCandidate } from "./mentions";
import type { ComposerDraft, ReferenceTarget } from "./references";
import type { Wire as Socket } from "../wire";

export type ChatProps = {
	wire: Socket | undefined;
	handle: string;
	connected: boolean;
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
	onRetryAnalysis?: (messageId: string, actionId: string) => Promise<void>;
	onRetryJob?: (jobId: string) => Promise<void>;
	decisions?: TranscriptDecisions;
	researchOffers?: ResearchOfferControls;
	sourceDestination?: ChatDestination;
};

export function Chat(
	{
		active = true,
		agent = true,
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
		referencesEnabled,
		repository,
		room,
		sendAcknowledgements,
		wire,
	}: ChatProps,
) {
	let [entries, setEntries] = useState<Wire.Entry[]>([]);
	let [queue, setQueue] = useState<Wire.Waiting[]>([]);
	let [busy, setBusy] = useState(false);
	let [turn, setTurn] = useState<Wire.Turn>();
	let [draft, setDraft] = useState<ComposerDraft>({
		text: "",
		references: [],
	});
	let [submitting, setSubmitting] = useState(false);
	let [sendError, setSendError] = useState<string>();
	let [selection, setSelection] = useState({ start: 0, end: 0 });
	let [dismissedPicker, setDismissedPicker] = useState<string>();
	let [mentionCursor, setMentionCursor] = useState<{ key?: string; index: number }>({ index: 0 });
	let textarea = useRef<HTMLTextAreaElement>(null);
	let pendingCaret = useRef<number | undefined>(undefined);
	let pendingEdit = useRef<{ start: number; end: number } | undefined>(undefined);
	let submission = useRef<object | undefined>(undefined);
	let draftRef = useRef(draft);
	draftRef.current = draft;
	let pickerId = useId();
	let mentionPickerId = useId();
	let instructionsId = useId();
	let synchronized = useRef<Socket | undefined>(undefined);
	let activity = useRef(onActivity);
	let reportedBusy = useRef(false);
	activity.current = onActivity;
	// A socket opens before its fresh transcript arrives, and reconnects reuse
	// the same Wire. Only that transcript makes this composer current.
	if (!connected) synchronized.current = undefined;
	let composerReady = connected && synchronized.current === wire;
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
			setTurn(current => current && !current.responded ? { ...current, responded: true } : current);
		};

		// Streaming arrives as deltas against an entry already in the list, so
		// the reducer here has to be additive rather than replacing.
		let off = [
			wire.on<Wire.History>("chat:history", frame => {
				loaded = true;
				synchronized.current = wire;
				seen = new Set(frame.entries.map(entry => entry.id));
				setEntries(frame.entries);
				setQueue(frame.queued);
				setBusy(frame.busy);
				reportedBusy.current = frame.busy;
				setTurn(frame.turn);
				// History is not unread, but a turn already in progress still needs
				// a signal outside a closed Chat destination.
				activity.current?.({ type: "working", busy: frame.busy });
			}),
			wire.on<Wire.Message>("chat:message", frame => {
				if (loaded && !seen.has(frame.entry.id)) {
					activity.current?.({ type: "message", busy: reportedBusy.current });
				}
				seen.add(frame.entry.id);
				setEntries(current => {
					let index = current.findIndex(entry => entry.id === frame.entry.id);
					if (index < 0) return [...current, frame.entry];
					let next = [...current];
					next[index] = frame.entry;
					return next;
				});
				response(frame.entry.author.kind === "agent", frame.entry.text);
			}),
			wire.on<Wire.Delta>("chat:delta", frame => {
				setEntries(current =>
					current.map(entry =>
						entry.id === frame.id ? { ...entry, text: entry.text + frame.text } : entry
					)
				);
				response(true, frame.text);
			}),
			wire.on<Wire.Tool>("chat:tool", frame => {
				setEntries(current => {
					let index = current.findIndex(entry => entry.id === frame.entry);
					if (index < 0) return current;
					let next = [...current];
					let entry = next[index]!;
					let tools = entry.tools ?? [];
					let existing = tools.findIndex(item => item.id === frame.activity.id);
					next[index] = {
						...entry,
						tools: existing < 0
							? [...tools, frame.activity]
							: tools.map((item, at) => at === existing ? { ...item, ...frame.activity } : item),
					};
					return next;
				});
			}),
			wire.on<Wire.State>("chat:state", frame => {
				if (loaded && reportedBusy.current !== frame.busy) {
					activity.current?.({ type: "working", busy: frame.busy });
				}
				reportedBusy.current = frame.busy;
				setBusy(frame.busy);
				setTurn(frame.turn);
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
		textarea.current?.setSelectionRange(caret, caret);
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
	};

	let submit = () => {
		if (submission.current || !composerReady || !wire) return;
		let current = draftRef.current;
		if (!current.text.trim()) return;
		let submitted = prepareDraftSubmission(current);
		let payload = chatSendPayload(
			submitted.text,
			submitted.references,
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

	let chooseReference = (target: ReferenceTarget) => {
		if (!trigger) return;
		let next = insertReference(draft.text, draft.references, trigger, target);
		setDraft(current => reviseComposerDraft(current, next.text, next.references));
		setSelection({ start: next.caret, end: next.caret });
		setSendError(undefined);
		setDismissedPicker(undefined);
		pendingEdit.current = undefined;
		pendingCaret.current = next.caret;
	};

	let chooseMention = (candidate: MentionCandidate) => {
		if (!mention) return;
		let next = insertMention(draft.text, mention, candidate);
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
		pendingEdit.current = undefined;
		pendingCaret.current = next.caret;
	};

	let moveMention = (to: (index: number) => number) =>
		setMentionCursor({ key: mentionKey, index: to(mentionActive) });

	return (
		<div className="flex h-full min-h-0 flex-col">
			<Transcript
				active={active}
				canEdit={connected}
				conversationPlanJobs={conversationPlanJobs}
				onCardLink={onCardLink}
				onAddExcerpt={onAddExcerpt}
				onRetryAnalysis={onRetryAnalysis}
				onRetryJob={onRetryJob}
				conversationPlan={conversationPlan}
				decisions={decisions}
				researchOffers={researchOffers}
				sourceDestination={sourceDestination}
				entries={entries}
				handle={handle}
				onWithdraw={id => wire?.send("chat:unqueue", { id })}
				queued={queue}
				working={connected && synchronized.current === wire && turn
					? turn
					: undefined}
			/>

			<div className="chat-composer relative shrink-0 px-2.5 pb-2.5">
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
				{mentionOpen && (
					<MentionPicker
						active={mentionActive}
						id={mentionPickerId}
						onActive={index => setMentionCursor({ key: mentionKey, index })}
						onSelect={chooseMention}
						options={mentionOptions}
					/>
				)}
				{referencesEnabled && (
					<p className="sr-only" id={instructionsId}>
						Type # to reference a document.
					</p>
				)}
				<div aria-busy={submitting} className="field flex flex-col">
					<textarea
						aria-activedescendant={mentionOpen
							? referenceOptionId(mentionPickerId, mentionActive)
							: pickerOpen && activeOption
							? referenceOptionId(pickerId, picker.options.indexOf(activeOption))
							: undefined}
						aria-autocomplete="list"
						aria-controls={mentionOpen ? mentionPickerId : pickerOpen ? pickerId : undefined}
						aria-describedby={referencesEnabled ? instructionsId : undefined}
						aria-disabled={!composerReady || submitting}
						aria-expanded={pickerOpen || mentionOpen}
						aria-haspopup="listbox"
						className="h-14 min-h-14 flex-1 w-full resize-none bg-transparent px-4 py-3 text-sm"
						readOnly={!composerReady || submitting}
						role="combobox"
						onBeforeInput={event => {
							let input = event.nativeEvent as InputEvent;
							pendingEdit.current = beforeInputSelection(
								event.currentTarget.selectionStart,
								event.currentTarget.selectionEnd,
								input.inputType ?? "",
								draft.text.length,
							);
						}}
						onChange={event => {
							let next = event.currentTarget.value;
							let edit = pendingEdit.current;
							pendingEdit.current = undefined;
							setDraft(current =>
								reviseComposerDraft(
									current,
									next,
									reconcileReferenceDrafts(
										current.text,
										next,
										current.references,
										edit,
									),
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
							if (mentionAction === "dismiss") {
								setDismissedPicker(mentionKey);
								event.preventDefault();
								event.stopPropagation();
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
							if (action === "dismiss") {
								setDismissedPicker(triggerKey);
								event.preventDefault();
								event.stopPropagation();
								return;
							}
							if (action === "select" && activeOption) {
								chooseReference(activeOption);
								event.preventDefault();
								return;
							}
							if (composing) return;
							// Enter sends; a newline needs a modifier, as everywhere else.
							if (event.key !== "Enter" || event.shiftKey) return;
							event.preventDefault();
							submit();
						}}
						onKeyUp={event =>
							setSelection({
								start: event.currentTarget.selectionStart,
								end: event.currentTarget.selectionEnd,
							})}
						onSelect={event =>
							setSelection({
								start: event.currentTarget.selectionStart,
								end: event.currentTarget.selectionEnd,
							})}
						placeholder={`Use ${MENTION} to ask Chopin`}
						ref={textarea}
						rows={3}
						value={draft.text}
					/>

					<div className="flex items-center justify-end gap-1 px-2 pb-2">
						{sendError && (
							<TerminalAlert className="mr-auto min-w-0 text-sm text-destructive-ink [overflow-wrap:anywhere]">
								{sendError}
							</TerminalAlert>
						)}
						{agent && busy && (
							<button
								aria-label="Stop Planner"
								className="btn btn-icon btn-secondary"
								onClick={() => wire?.send("chat:abort")}
								title="Stop Planner"
								type="button"
							>
								<img alt="" className="size-[14px]" src={plannerStop} />
							</button>
						)}
						<SendAction
							disabled={!composerReady || submitting || !draft.text.trim()}
							onClick={submit}
							label="Send message"
						/>
					</div>
				</div>
			</div>
		</div>
	);
}
