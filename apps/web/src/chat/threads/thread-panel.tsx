import { lazy, Suspense, useEffect, useId, useLayoutEffect, useRef, useState } from "react";

import { ChopinMark, Face, usePopoverDismissal } from "@chopin/editor";
import { ArrowLeftIcon, CloseIcon } from "@chopin/icons";
import { formatForkedClock, isReplyEntry, replyCountLabel } from "@chopin/protocol/threads";

import { WireLost, WireRefusal } from "../../wire";
import {
	asksChopin,
	chipKeyAction,
	chipShown,
	takeChopinMention,
	withoutChopinMentions,
} from "../chopin-chip";
import { sendFailureView } from "../failure";
import { applyFormat } from "../format-markdown";
import { keepFormatPreference, readFormatPreference } from "../format-preference";
import { MessageMarkdown } from "../markdown";
import { MentionPicker, mentionRows } from "../mention-picker";
import { pointerGroups, useMentionSources } from "../mention-sources";
import {
	chatAuthors,
	filterMentions,
	insertMention,
	mentionCandidates,
	mentionKeyAction,
	mentionTriggerKey,
	pointerTrigger,
} from "../mentions";
import { capitalize, displayText } from "../model";
import {
	referenceOptionId,
	ReferencePicker,
	referencePickerKeyAction,
	useReferencePicker,
} from "../reference-picker";
import {
	acknowledgeDraft,
	insertPointer,
	insertReference,
	MAX_REFERENCES,
	prepareDraftSubmission,
	reconcileReferenceDrafts,
	referenceTrigger,
	referenceTriggerKey,
	repliesOffNotice,
	reviseComposerDraft,
	sendFailure,
} from "../references";
import { runCounts, RunStack } from "../run-card";
import { Transcript } from "../transcript";
import { progressOf } from "../transcript-state";
import { canWithdraw } from "../withdraw";
import { ThreadComposerBoundary } from "./composer-boundary";
import "./thread-panel.css";

import type { Chat as Wire } from "@chopin/protocol";
import type { Wire as Socket } from "../../wire";
import type { ComposerNotice } from "../composer";
import type { DraftInputHandle } from "../draft-input";
import type { Format } from "../format-markdown";
import type { MentionRow } from "../mention-picker";
import type { PointerOption } from "../mention-sources";
import type { MentionCandidate } from "../mentions";
import type { ComposerDraft, ReferenceTarget, SendFailure } from "../references";
import type { TranscriptDecisions } from "../transcript";
import type { ModelControl } from "../use-model-choice";
import type { ThreadViewState } from "./thread-model";

let LazyContextRing = lazy(() => import("../context/context-ring"));
let MessageFiles = lazy(() => import("../attachments/message-files"));

const LEADING_MENTION = /^\s*@chopin\b[^\S\n]*/i;

function rootTime(ts: number): string {
	return new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function RootMessageCard({ entry, room }: { entry: Wire.Entry; room: string }) {
	let toPlanner = entry.to === "planner" && entry.author.kind === "member";
	let lead = toPlanner ? LEADING_MENTION.exec(entry.text)?.[0].length ?? 0 : 0;
	let text = toPlanner ? entry.text.slice(lead) : entry.text;
	let references = lead
		? entry.references?.filter(item => item.start >= lead)
			.map(item => ({ ...item, start: item.start - lead, end: item.end - lead }))
		: entry.references;
	if (
		!toPlanner && !displayText(text) && entry.author.kind === "member" && !entry.attachments?.length
	) {
		text = "Ask Chopin";
	}
	let name = entry.author.kind === "agent"
		? "Chopin"
		: entry.author.kind === "member"
		? capitalize(entry.author.handle)
		: "System";

	return (
		<div className="thread-root-entry" data-thread-root-message={entry.id}>
			<div className="w-6 shrink-0">
				{entry.author.kind === "agent"
					? <ChopinMark circle />
					: entry.author.kind === "member"
					? <Face decorative handle={entry.author.handle} size={24} titled={false} />
					: null}
			</div>
			<div className="flex min-w-0 flex-1 flex-col gap-1 -mt-0.5">
				<div className="flex items-baseline gap-1.5 text-sm">
					<span className="min-w-0 break-all font-semibold">{name}</span>
					<span className="text-2xs text-text-tertiary tabular-nums">
						{rootTime(entry.ts)}
					</span>
				</div>
				{(text || toPlanner) && (
					<div className="min-w-0" data-thread-root-text="">
						<MessageMarkdown
							className="break-words text-chat-body [overflow-wrap:anywhere]"
							mention={toPlanner ? "@chopin" : undefined}
							references={references}
							source={text}
						/>
					</div>
				)}
				{!!entry.attachments?.length && (
					<Suspense fallback={null}>
						<MessageFiles channelId={room} files={entry.attachments} />
					</Suspense>
				)}
			</div>
		</div>
	);
}

export type ThreadPanelProps = {
	view: ThreadViewState;
	summaryCount?: number;
	sheet: boolean;
	agent: boolean;
	offline: boolean;
	connected: boolean;
	readonly: boolean;
	archived: boolean;
	handle: string;
	people: readonly string[];
	focus?: string;
	room: string;
	repository: { id: string; owner: string; name: string };
	referencesEnabled: boolean;
	sendAcknowledgements: boolean;
	modelControl?: ModelControl;
	modelNotice?: ComposerNotice;
	decisions?: TranscriptDecisions;
	loadStages: (
		runId: string,
		page: { offset: number; limit: number },
		signal: AbortSignal,
	) => Promise<{ stages: Wire.RunStage[]; total: number }>;
	onShowDecisions?: () => void;
	onAlsoToChatChange: (checked: boolean) => void;
	onClose: (options?: { restoreFocus?: boolean }) => void;
	wire?: Socket;
};

export function ThreadPanel(
	{
		view,
		summaryCount,
		sheet,
		agent,
		offline,
		connected,
		readonly,
		archived,
		handle,
		people,
		focus,
		room,
		repository,
		referencesEnabled,
		sendAcknowledgements,
		modelControl,
		modelNotice,
		decisions,
		loadStages,
		onShowDecisions,
		onAlsoToChatChange,
		onClose,
		wire,
	}: ThreadPanelProps,
) {
	let panelRef = useRef<HTMLElement>(null);
	let composerRoot = useRef<HTMLDivElement>(null);
	let textarea = useRef<DraftInputHandle>(null);
	let [draft, setDraft] = useState<ComposerDraft>({ text: "", references: [] });
	let draftRef = useRef(draft);
	draftRef.current = draft;
	let [chipOn, setChipOn] = useState(false);
	let [selection, setSelection] = useState({ start: 0, end: 0 });
	let [dismissedPicker, setDismissedPicker] = useState<string>();
	let [mentionCursor, setMentionCursor] = useState<{ key?: string; index: number }>({ index: 0 });
	let [historyKey, setHistoryKey] = useState(0);
	let [submitting, setSubmitting] = useState(false);
	let [sendError, setSendError] = useState<SendFailure & { code?: string }>();
	let [formatting, setFormatting] = useState(() => readFormatPreference(handle));
	let pendingCaret = useRef<number | { start: number; end: number } | undefined>(undefined);
	let submission = useRef<object | undefined>(undefined);
	let pickerId = useId();
	let mentionPickerId = useId();
	let headingId = useId();

	useEffect(() => {
		if (readonly || archived) return;
		let frame = requestAnimationFrame(() => textarea.current?.focus());
		return () => cancelAnimationFrame(frame);
	}, [view.rootId, readonly, archived]);

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

	let draftable = !readonly && !archived;
	let composerReady = connected && !readonly && !archived;
	let chip = chipShown({
		agent: !!agent,
		chip: chipOn,
		text: draft.text,
		references: draft.references,
		submitted: draft.submission?.to,
	});
	let askingChopin = asksChopin({
		agent: !!agent,
		chip: chipOn,
		text: draft.text,
		references: draft.references,
		submitted: draft.submission?.to,
	});

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
	let authors = chatAuthors([
		...(view.root ? [view.root] : []),
		...view.transcript.entries,
	]);
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
	let activeOption = picker.options.length === 0
		? undefined
		: picker.options[Math.min(picker.active, picker.options.length - 1)];

	usePopoverDismissal(
		mentionOpen || pickerOpen,
		target =>
			composerRoot.current?.contains(target)
			&& !!(target as Element).closest?.(
				"[contenteditable], [data-chat-mention-picker], [data-chat-reference-picker]",
			),
		() => setDismissedPicker(mentionOpen ? mentionKey : triggerKey),
	);

	let toggleFormatting = () => {
		keepFormatPreference(handle, !formatting);
		setFormatting(on => !on);
	};

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

	let setChip = (on: boolean) => {
		if (!draftable || submitting || !agent || chip === on) return;
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

	let clearSubmittedDraft = (submitted: ComposerDraft) => {
		if (draftRef.current !== submitted) return;
		let cleared = acknowledgeDraft(submitted, submitted);
		draftRef.current = cleared;
		setDraft(cleared);
		setSelection({ start: 0, end: 0 });
		setDismissedPicker(undefined);
		setHistoryKey(current => current + 1);
		if (view.alsoToChat) onAlsoToChatChange(false);
	};

	let submit = () => {
		if (submission.current || !draftable || !composerReady || !wire?.connected) return;
		let current = draftRef.current;
		if (!current.text.trim()) return;
		let submitted = prepareDraftSubmission(current, undefined, {
			planner: agent,
			asking: askingChopin,
			referencesEnabled,
			focus,
		});
		if (!submitted) return;
		let payload: Omit<Wire.Send, "kind" | "ts"> = {
			...submitted.submission,
			thread: view.rootId,
			...(view.alsoToChat ? { alsoToChat: true } : {}),
		};
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
			requestAnimationFrame(() => textarea.current?.focus());
			return;
		}

		void wire.ask<Wire.Sent>("chat:send", payload).then(
			() => {
				clearSubmittedDraft(submitted);
			},
			(error: unknown) => {
				if (!(error instanceof WireLost && error.restarting)) {
					setSendError({
						...sendFailure(error),
						...(error instanceof WireRefusal && error.code ? { code: error.code } : {}),
					});
				}
			},
		).finally(() => {
			if (submission.current !== token) return;
			submission.current = undefined;
			setSubmitting(false);
			requestAnimationFrame(() => textarea.current?.focus());
		});
	};

	let counts = runCounts(view.runs);
	let { working: workingTurn, suspended: suspendedWork } = progressOf(
		view.transcript,
		connected && view.loaded,
		false,
	);
	let replyCount = Math.max(
		summaryCount ?? 0,
		view.transcript.entries.filter(isReplyEntry).length,
	);
	let clocked = formatForkedClock(view.forkedAt);
	let sendErrView = sendError && !offline
		? sendFailureView(sendError, sendError.code)
		: undefined;
	let composerNotice: ComposerNotice | undefined = sendErrView
		? { tone: "error", text: sendErrView.title }
		: !agent
		? repliesOffNotice(offline)
		: modelNotice;

	let lead = (
		<div className="thread-lead">
			<p className="thread-provenance" data-thread-provenance="">
				Forked from Chat at {clocked}. Chopin remembers everything up to here.
			</p>
			{view.root && <RootMessageCard entry={view.root} room={room} />}
			{(replyCount > 0 || view.queue.length > 0 || !!workingTurn) && (
				<div className="thread-replies-rule" data-thread-replies-rule="">
					<span>{replyCountLabel(Math.max(1, replyCount))}</span>
				</div>
			)}
		</div>
	);

	return (
		<section
			aria-labelledby={headingId}
			className="thread-panel"
			data-thread-panel={view.rootId}
			data-thread-sheet={sheet || undefined}
			onKeyDown={event => {
				if (event.key !== "Escape" || event.defaultPrevented) return;
				if (mentionOpen || pickerOpen) return;
				event.preventDefault();
				event.stopPropagation();
				onClose({ restoreFocus: true });
			}}
			ref={panelRef}
		>
			<header className="thread-panel-header">
				{sheet && (
					<button
						aria-label="Back to Chat"
						className="btn btn-icon btn-ghost shrink-0"
						data-tooltip="Back to Chat"
						onClick={() => onClose({ restoreFocus: true })}
						type="button"
					>
						<ArrowLeftIcon aria-hidden="true" />
					</button>
				)}
				<div className="thread-panel-titles">
					<h3 className="thread-panel-title m-0" id={headingId}>Thread</h3>
					<span className="thread-panel-subtitle">Chat</span>
				</div>
				{!sheet && (
					<button
						aria-label="Close thread"
						className="btn btn-icon btn-ghost shrink-0"
						data-tooltip="Close thread"
						onClick={() => onClose({ restoreFocus: true })}
						type="button"
					>
						<CloseIcon aria-hidden="true" />
					</button>
				)}
			</header>

			<Transcript
				active
				canEdit={composerReady}
				compacting={view.compacting}
				compactions={view.compactions}
				completedWork={view.transcript.completedWork}
				decisions={decisions}
				entries={view.transcript.entries}
				handle={handle}
				lead={lead}
				live={connected && view.loaded}
				onDelete={id => void wire?.ask("chat:delete", { id, thread: view.rootId }).catch(() => {})}
				onRetry={id => void wire?.ask("chat:retry", { id, thread: view.rootId }).catch(() => {})}
				onWithdraw={id => {
					if (canWithdraw(view.queue, id, handle)) {
						wire?.send("chat:unqueue", { id, thread: view.rootId });
					}
				}}
				queued={view.queue}
				room={room}
				suspendedWork={suspendedWork}
				working={workingTurn}
			/>

			{agent && !!view.runs?.length && (
				<div className="flex shrink-0 flex-col px-2.5 pb-2" data-thread-runs="">
					<RunStack
						loadStages={loadStages}
						offline={offline}
						onPause={runId =>
							wire?.send("chat:pause-run", { runId, thread: view.rootId })}
						onResume={runId =>
							wire?.send("chat:resume-run", { runId, thread: view.rootId })}
						onShowDecisions={onShowDecisions}
						runs={view.runs}
					/>
				</div>
			)}

			<ThreadComposerBoundary
				agent={agent}
				alsoDisabled={!draftable || submitting}
				alsoToChat={view.alsoToChat}
				chopin={agent
					? {
						chip,
						disabled: !draftable || submitting,
						onAdd: () => setChip(true),
						onRemove: () => setChip(false),
					}
					: undefined}
				contextRing={view.usage
					? (
						<Suspense fallback={null}>
							<LazyContextRing usage={view.usage} />
						</Suspense>
					)
					: undefined}
				draftable={draftable}
				format={sheet
					? undefined
					: {
						shown: formatting,
						disabled: !composerReady || submitting,
						onToggle: toggleFormatting,
						onFormat: formatDraft,
					}}
				input={{
					"aria-activedescendant": mentionOpen
						? referenceOptionId(mentionPickerId, mentionActive)
						: pickerOpen && activeOption
						? referenceOptionId(pickerId, picker.options.indexOf(activeOption))
						: undefined,
					"aria-controls": mentionOpen
						? mentionPickerId
						: pickerOpen
						? pickerId
						: undefined,
					"aria-expanded": pickerOpen || mentionOpen,
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
					},
					onKeyDown: event => {
						let composing = event.nativeEvent.isComposing || event.keyCode === 229;
						let chipAction = agent && draftable && !submitting
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
							setMentionCursor({
								key: mentionKey,
								index: (mentionActive + 1) % mentionRowsShown.length,
							});
							event.preventDefault();
							return;
						}
						if (mentionAction === "previous") {
							setMentionCursor({
								key: mentionKey,
								index: (mentionActive - 1 + mentionRowsShown.length) % mentionRowsShown.length,
							});
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
					onSelect: event =>
						setSelection({
							start: event.currentTarget.selectionStart,
							end: event.currentTarget.selectionEnd,
						}),
					value: draft.text,
				}}
				inputRef={textarea}
				mention={{ disabled: !composerReady || submitting, onMention: startMention }}
				model={modelControl}
				notice={composerNotice}
				onAlsoToChatChange={onAlsoToChatChange}
				onSubmit={submit}
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
				rootRef={composerRoot}
				run={agent && (view.busy || counts.active > 0)
					? {
						action: "stop",
						disabled: !composerReady,
						onClick: () => wire?.send("chat:abort", { thread: view.rootId }),
					}
					: agent && !view.busy && !counts.active && counts.paused > 0
					? {
						action: "resume",
						disabled: !composerReady,
						onClick: () => wire?.send("chat:resume", { thread: view.rootId }),
					}
					: undefined}
				sendDisabled={!draftable || submitting || !draft.text.trim() || !composerReady}
				sending={submitting}
				unavailable={archived ? "archived" : readonly ? "readonly" : undefined}
			/>
		</section>
	);
}

export default ThreadPanel;
