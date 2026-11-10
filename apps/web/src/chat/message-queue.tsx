/**
 * The queue of messages waiting for Chopin, above the composer.
 *
 * Adapted from assistant-ui's standalone `MessageQueue` element
 * (packages/ui/src/components/react/assistant-ui/elements/message-queue.tsx at commit
 * f92028b466cba721846de6851e4dddb6c04ecfad of https://github.com/assistant-ui/assistant-ui),
 * Copyright (c) 2026 AgentbaseAI Inc., MIT license; see THIRD_PARTY_NOTICES.md at the repository
 * root. It keeps the element's structure and states: a count line, an ordered list with each
 * waiting message's place and a single-line preview, a control to cancel it that appears only
 * where the caller allows it (so a queue with no `onCancel` is the element's no-cancel state), and
 * nothing at all when nothing waits. It is driven only by the props below, which Chat fills from
 * the server's queue; it uses none of assistant-ui's runtime. Restyled to Chopin's tokens, text
 * roles, buttons and motion, and extended with who asked, a way to edit a message before it starts,
 * and the plain words a refused change is told in. The element's own "running" row is left out:
 * the turn that is running already shows in the transcript.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChopinMark, Face } from "@chopin/editor";
import { useTransitionPresence } from "@chopin/editor/transition-presence";

import { motionContract } from "../motion-contract";
import { DeliveryMark, MessageMenu } from "./message-delivery";
import { editedText, focusAfterRemoval, queueCaption, refusalWords } from "./queue-model";
import "./message-queue.css";

import type { FormEvent, KeyboardEvent } from "react";
import type { QueueRow } from "./queue-model";

const MOTION = motionContract("collapse");

/** How long a word about a change that could not be made stays once the row it was about is gone. */
const NOTICE_MS = 8_000;

/** A change's answer: the plain words it was refused in, or nothing when it was made. */
export type Answer = Promise<string | undefined>;

type Props = {
	queued: readonly QueueRow[];
	/** Cancel a message of the person's own; absent where the person cannot change anything. */
	onCancel?: (id: string) => Answer;
	/** Rewrite a message of the person's own before it starts. */
	onEdit?: (id: string, text: string) => Answer;
	/** Take a saved message back, including while offline. */
	onDelete?: (id: string) => void;
	/** Messages known to have started, so a different removal is not called a start. */
	started?: ReadonlySet<string>;
	/** Where focus goes when the last row leaves, and nothing is left to take it. */
	restoreFocus?: () => void;
};

export function MessageQueue({ queued, onCancel, onEdit, onDelete, started, restoreFocus }: Props) {
	// A word about a change that could not be made outlives the row it was about, which leaves the
	// queue when its turn starts: it stays a few seconds, in the queue's own card.
	let [notice, setNotice] = useState<string>();
	useEffect(() => {
		if (!notice) return;
		let timer = setTimeout(() => setNotice(undefined), NOTICE_MS);
		return () => clearTimeout(timer);
	}, [notice]);
	let live = useRef(queued);
	live.current = queued;
	let begun = useRef(started);
	begun.current = started;
	// The card's height while it held something, which it keeps as it eases shut empty: what was in
	// it has gone to the transcript or been cancelled, and is not drawn a second time as it goes.
	let height = useRef(0);
	let presence = useTransitionPresence(
		queued.length > 0 || notice ? "queue" : undefined,
		MOTION.closeDuration,
		false,
	);
	if (presence.phase === "closed") return null;
	let closing = presence.phase === "closing";
	return (
		<div
			aria-hidden={closing || undefined}
			className={presence.className === "is-open"
				? "chat-queue-motion motion-collapse is-open"
				: closing
				? "chat-queue-motion motion-collapse is-closing"
				: "chat-queue-motion motion-collapse"}
			inert={closing}
		>
			<div className="motion-collapse-content">
				<div className="chat-queue-inset">
					{closing
						? <div aria-hidden="true" className="chat-queue" style={{ height: height.current }} />
						: (
							<Queue
								notice={notice}
								onCancel={onCancel}
								onDelete={onDelete}
								onEdit={onEdit}
								onNotice={setNotice}
								onSize={size => height.current = size}
								queued={queued}
								restoreFocus={restoreFocus}
								started={id => !!begun.current?.has(id)}
								waiting={id => live.current.some(row => row.id === id)}
							/>
						)}
				</div>
			</div>
		</div>
	);
}

function Queue(
	{ queued, notice, onNotice, onSize, waiting, onCancel, onEdit, onDelete, started, restoreFocus }:
		& Omit<Props, "started">
		& {
			notice?: string;
			onNotice: (words: string | undefined) => void;
			/** Told the card's height after each draw. */
			onSize: (height: number) => void;
			/** Whether a message still waits, as the server says now rather than as the card last drew it. */
			waiting: (id: string) => boolean;
			started: (id: string) => boolean;
		},
) {
	let list = useRef<HTMLOListElement>(null);
	let card = useRef<HTMLDivElement>(null);
	let atEnd = useRef(true);
	useLayoutEffect(() => {
		if (card.current) onSize(card.current.offsetHeight);
	});
	useLayoutEffect(() => {
		if (list.current && atEnd.current) list.current.scrollTop = list.current.scrollHeight;
	}, [queued.length]);
	let [said, setSaid] = useState("");
	let [notes, setNotes] = useState<ReadonlyMap<string, string>>(new Map());

	let note = (id: string, words: string | undefined) =>
		setNotes(current => {
			let next = new Map(current);
			if (words) next.set(id, words);
			else next.delete(id);
			return next;
		});

	let cancel = onCancel && (async (row: QueueRow) => {
		let neighbour = focusAfterRemoval(queued, row.id);
		note(row.id, undefined);
		let refused = await onCancel(row.id);
		if (refused) return refuse(row, refused);
		setSaid(`Cancelled the message from ${row.name}.`);
		let next = neighbour
			? list.current?.querySelector<HTMLElement>(
				`[data-queue-id="${CSS.escape(neighbour)}"] button`,
			)
			: undefined;
		if (next) next.focus();
		else restoreFocus?.();
	});

	let edit = onEdit && (async (row: QueueRow, text: string) => {
		note(row.id, undefined);
		let refused = await onEdit(row.id, text);
		if (refused) {
			refuse(row, refused);
			return refused;
		}
		setSaid("Saved the change.");
		return undefined;
	});

	// Said beside the row while it is there, and in the card once it has left the queue.
	let refuse = (row: QueueRow, words: string) => {
		setSaid(words);
		if (waiting(row.id)) note(row.id, words);
		else onNotice(words);
	};
	let left = (row: QueueRow) => {
		// Typing a change into a message whose turn started: what was typed was not saved.
		if (!waiting(row.id) && started(row.id)) {
			onNotice(refusalWords("edit", { code: "already-started" }));
		}
	};

	return (
		<div
			aria-label="Waiting for Chopin"
			className="chat-queue"
			data-chat-queue=""
			data-slot="message-queue"
			ref={card}
			role="region"
		>
			{queued.length > 0 && <p className="chat-queue-caption">{queueCaption(queued.length)}</p>}
			<ol
				className="chat-queue-list"
				onScroll={event => {
					let element = event.currentTarget;
					atEnd.current = element.scrollHeight - element.clientHeight - element.scrollTop <= 1;
				}}
				ref={list}
			>
				{queued.map((row, index) => (
					<Item
						cancel={cancel}
						edit={edit}
						onDelete={onDelete}
						index={index + 1}
						key={row.id}
						note={notes.get(row.id)}
						onLeave={left}
						row={row}
					/>
				))}
			</ol>
			{notice && <p className="chat-queue-notice" data-chat-queue-notice="">{notice}</p>}
			<span aria-atomic="true" aria-live="polite" className="sr-only" role="status">{said}</span>
		</div>
	);
}

function Item(
	{ row, index, note, cancel, edit, onDelete, onLeave }: {
		row: QueueRow;
		index: number;
		note?: string;
		cancel?: (row: QueueRow) => Promise<void>;
		edit?: (row: QueueRow, text: string) => Promise<string | undefined>;
		onDelete?: (id: string) => void;
		/** Called when the row goes while its message is open for editing. */
		onLeave: (row: QueueRow) => void;
	},
) {
	let [editing, setEditing] = useState(false);
	let [busy, setBusy] = useState(false);
	let editor = useRef<HTMLButtonElement>(null);
	let restoreEditor = useRef(false);
	useLayoutEffect(() => {
		if (!editing && restoreEditor.current) {
			restoreEditor.current = false;
			editor.current?.focus();
		}
	}, [editing]);
	let open = useRef(false);
	open.current = editing;
	useEffect(() => () => {
		if (open.current) onLeave(row);
	}, []);
	let controls = row.mine && !!(cancel || edit);

	return (
		<li
			aria-busy={busy || undefined}
			className="chat-queue-item"
			data-chat-queue-item=""
			data-chat-message-id={row.message ? row.id : undefined}
			data-queue-id={row.id}
			data-queue-kind={row.message ? "message" : "work"}
		>
			<span aria-hidden="true" className="chat-queue-place">{index}</span>
			<div className="chat-queue-body">
				<div className="chat-queue-who">
					{row.handle
						? <Face decorative handle={row.handle} size={16} titled={false} />
						: <ChopinMark />}
					<span className="chat-queue-name">{row.name}</span>
				</div>
				{editing && edit
					? (
						<Editor
							busy={busy}
							note={note}
							onClose={() => {
								restoreEditor.current = true;
								setEditing(false);
							}}
							onSave={async text => {
								setBusy(true);
								let refused = await edit(row, text);
								setBusy(false);
								if (!refused) {
									restoreEditor.current = true;
									setEditing(false);
								}
							}}
							text={row.text}
						/>
					)
					: (
						<>
							<div className="chat-queue-preview">
								<p
									className="chat-queue-text"
									data-chat-queue-text=""
									title={row.text}
								>
									{row.text}
								</p>
								{row.mine && row.sent && <DeliveryMark mark="sent" />}
							</div>
							{note && <p className="chat-queue-note" role="alert">{note}</p>}
						</>
					)}
			</div>
			{(controls || (row.mine && row.sent && onDelete)) && !editing && (
				<div className="chat-queue-actions">
					{controls && edit && (
						<button
							aria-label={`Edit message from ${row.name}`}
							className="btn btn-xs btn-ghost"
							disabled={busy}
							onClick={() => setEditing(true)}
							ref={editor}
							type="button"
						>
							Edit
						</button>
					)}
					{controls && cancel && (
						<button
							aria-label={`Cancel message from ${row.name}`}
							className="btn btn-xs btn-ghost"
							disabled={busy}
							onClick={async () => {
								setBusy(true);
								await cancel(row);
								setBusy(false);
							}}
							type="button"
						>
							Cancel
						</button>
					)}
					{row.mine && row.sent && onDelete && <MessageMenu onDelete={() => onDelete(row.id)} />}
				</div>
			)}
		</li>
	);
}

/** The message itself, to rewrite: Enter saves, Shift and Enter add a line, Escape leaves it as it was. */
function Editor(
	{ text, busy, note, onSave, onClose }: {
		text: string;
		busy: boolean;
		note?: string;
		onSave: (text: string) => Promise<void>;
		onClose: () => void;
	},
) {
	let [draft, setDraft] = useState(text);
	let field = useRef<HTMLTextAreaElement>(null);
	let changed = editedText(text, draft);
	useEffect(() => {
		let box = field.current;
		if (!box) return;
		box.focus();
		box.setSelectionRange(box.value.length, box.value.length);
	}, []);
	let submit = (event?: FormEvent) => {
		event?.preventDefault();
		if (changed && !busy) void onSave(changed);
	};
	let keys = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			if (!busy) onClose();
		} else if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
			event.preventDefault();
			submit();
		}
	};
	return (
		<form className="chat-queue-edit" data-chat-queue-edit="" onSubmit={submit}>
			<textarea
				aria-label="Edit message"
				className="field chat-queue-field"
				disabled={busy}
				onChange={event => setDraft(event.target.value)}
				onKeyDown={keys}
				ref={field}
				rows={2}
				value={draft}
			/>
			{note && <p className="chat-queue-note" role="alert">{note}</p>}
			<div className="chat-queue-edit-actions">
				<button
					aria-busy={busy || undefined}
					className="btn btn-xs btn-primary"
					disabled={!changed || busy}
					type="submit"
				>
					Save
				</button>
				<button
					className="btn btn-xs btn-ghost"
					disabled={busy}
					onClick={onClose}
					type="button"
				>
					Cancel edit
				</button>
			</div>
		</form>
	);
}
