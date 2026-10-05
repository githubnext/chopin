/**
 * A comment thread, as a card in the sidecar.
 *
 * Four states, and the difference between them is who can still act. A draft
 * has a passage but no thread yet. An open thread takes replies from anyone.
 * An accepted one is frozen — that is what accepting means — and reads as a
 * decision. A dismissed one is not rendered at all.
 *
 * Accept and dismiss both confirm on a second click, because neither can be
 * undone: accepting freezes the thread, puts a decision in the document and starts
 * a turn. That is the same two-click shape `QuestionView` uses for cancelling,
 * so it is an interaction people have already met here.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowUpIcon, CheckIcon, ChevronIcon, CloseIcon, MessageIcon } from "@chopin/icons";

import { limits } from "@chopin/dialect";

import { Provenance, SidecarCard, when } from "./card";
import { displayName } from "./display-name";
import { Face } from "./face";
import { PRIMARY_COARSE_POINTER_QUERY } from "./pointer";

import type { KeyboardEvent, ReactNode } from "react";
import type { Comment } from "@chopin/protocol";
import type { ThreadView } from "./threads";

/** Chat's author row: face, display name, quiet timestamp. The handle stays in the name. */
export function Author({ handle, ts }: { handle: string; ts?: number }) {
	return (
		<span className="flex min-w-0 items-center gap-2 text-sm">
			<Face handle={handle} size={20} titled={false} />
			<span className="min-w-0 truncate font-semibold" title={`@${handle}`}>
				{displayName(handle)}
				<span className="sr-only">(@{handle})</span>
			</span>
			{ts !== undefined && (
				<span className="shrink-0 text-text-quaternary tabular-nums">{when(ts)}</span>
			)}
		</span>
	);
}

function Note({
	action,
	note,
	opening,
}: {
	action?: ReactNode;
	note: Comment.Note;
	opening?: boolean;
}) {
	return (
		<li
			className="flex flex-col gap-0.5"
			data-plan-comment-opening-note={opening || undefined}
		>
			<div className="flex min-h-7 items-center justify-between gap-2">
				<Author handle={note.handle} ts={note.ts} />
				{action}
			</div>
			<p className="m-0 pl-7 text-sm whitespace-pre-wrap text-text-primary">{note.text}</p>
		</li>
	);
}

function CloseButton({ onClose }: { onClose: () => void }) {
	return (
		<button
			aria-label="Close comment"
			className="plan-comment-close btn btn-icon btn-ghost"
			data-plan-comment-close
			onClick={onClose}
			title="Close comment"
			type="button"
		>
			<CloseIcon aria-hidden="true" size={14} />
		</button>
	);
}

function DraftHeader({ onClose }: { onClose: () => void }) {
	return (
		<header
			className="flex min-h-7 items-center justify-between text-text-tertiary"
			data-plan-comment-draft-header
		>
			<MessageIcon aria-hidden="true" size={14} />
			<CloseButton onClose={onClose} />
		</header>
	);
}

/** Context is repeated only when its source passage can no longer be reached. */
function Quote({ drifted, text }: { drifted?: boolean; text: string }) {
	return (
		<div className="plan-comment-context flex flex-col gap-1" data-plan-comment-context>
			<blockquote className="plan-comment-context-copy m-0 text-sm text-text-secondary">
				{text}
			</blockquote>
			{drifted && (
				<p className="m-0 text-sm text-warning-ink">
					This passage has changed since the comment was added.
				</p>
			)}
		</div>
	);
}

/**
 * What a key does in a comment composer.
 *
 * Enter sends and Shift-Enter is a newline, the convention the chat composer
 * follows. A soft keyboard has no Shift-Enter, so on a coarse pointer Enter is a
 * newline and only the send button sends. Enter that confirms an IME candidate
 * never sends.
 */
export function composerKey(
	event: { key: string; shiftKey: boolean; isComposing: boolean; keyCode?: number },
	coarse: boolean,
): "send" | "cancel" | undefined {
	if (event.key === "Escape") return "cancel";
	if (event.key !== "Enter" || event.shiftKey || coarse) return undefined;
	if (event.isComposing || event.keyCode === 229) return undefined;
	return "send";
}

/** A textarea with its send button inside, shared by new comments and replies. */
function Composer({
	autoFocus,
	busy,
	label,
	onCancel,
	onSend,
	onTyping,
	placeholder,
	sendLabel,
}: {
	autoFocus?: boolean;
	busy?: boolean;
	label: string;
	onCancel?: () => void;
	onSend: (text: string) => void;
	onTyping?: (writing: boolean) => void;
	placeholder: string;
	sendLabel?: string;
}) {
	let [text, setText] = useState("");
	let ref = useRef<HTMLTextAreaElement>(null);

	useEffect(() => {
		if (autoFocus) ref.current?.focus();
	}, [autoFocus]);

	useLayoutEffect(() => {
		let field = ref.current;
		if (!field) return;
		field.style.height = "0px";
		let height = Math.min(field.scrollHeight, 160);
		field.style.height = `${height}px`;
		field.style.overflowY = field.scrollHeight > height ? "auto" : "hidden";
	}, [text]);

	// Whoever is typing stops being told about the moment this goes away, so
	// an unmount does not leave a caret blinking in somebody else's sidecar.
	useEffect(() => () => onTyping?.(false), [onTyping]);

	let send = () => {
		let value = text.trim();
		if (!value || busy) return;
		setText("");
		onTyping?.(false);
		onSend(value);
	};

	let key = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		let action = composerKey(
			{
				key: event.key,
				shiftKey: event.shiftKey,
				isComposing: event.nativeEvent.isComposing,
				keyCode: event.keyCode,
			},
			matchMedia(PRIMARY_COARSE_POINTER_QUERY).matches,
		);
		if (action === "cancel" && onCancel) {
			event.preventDefault();
			onCancel();
		} else if (action === "send") {
			event.preventDefault();
			send();
		}
	};

	return (
		<div
			className="plan-comment-composer relative"
			data-inset-send
			data-plan-comment-composer-shell
		>
			<textarea
				ref={ref}
				className="plan-comment-composer-field field block min-h-16 w-full resize-none px-2 py-1.5 text-sm"
				disabled={busy}
				maxLength={limits.MAX_NOTE}
				onChange={event => {
					setText(event.target.value);
					onTyping?.(event.target.value.length > 0);
				}}
				onKeyDown={key}
				placeholder={placeholder}
				value={text}
			/>
			<button
				aria-label={sendLabel ?? `Send ${label.toLowerCase()}`}
				className="plan-comment-send btn btn-icon btn-primary absolute right-2 bottom-2 rounded-full"
				disabled={!text.trim() || busy}
				onClick={send}
				title={sendLabel ?? `Send ${label.toLowerCase()}`}
				type="button"
			>
				<ArrowUpIcon aria-hidden="true" size={14} />
			</button>
		</div>
	);
}

export type ThreadCardProps = {
	view: ThreadView;
	quote: string;
	writing?: string[];
	focused?: boolean;
	busy?: boolean;
	/** Whether durable thread actions are available to this viewer. */
	canEdit?: boolean;
	/** True once the agent has said what an accepted thread produced. */
	applied?: boolean;
	onReply: (text: string) => void;
	onAccept: () => void;
	onDismiss: () => void;
	onRetry: () => void;
	onTyping: (writing: boolean) => void;
	onFocus: () => void;
	onBlur: () => void;
	/** Dismiss a document dialog without changing the durable thread. */
	onClose?: () => void;
	/** Desktop owns visible close chrome; a compact sheet owns dismissal itself. */
	showClose?: boolean;
	/** The overlay is document chrome rather than an item in the decisions rail. */
	inDocument?: boolean;
	/** Return to the list of a block's threads this one was opened from. */
	onBack?: () => void;
	backLabel?: string;
};

export function ThreadCard({
	applied,
	busy,
	canEdit = true,
	focused,
	onAccept,
	onBlur,
	onClose,
	onDismiss,
	onFocus,
	onReply,
	onRetry,
	onTyping,
	quote,
	inDocument,
	onBack,
	backLabel,
	showClose = true,
	view,
	writing,
}: ThreadCardProps) {
	let { thread } = view;
	let open = thread.status === "open";
	let [confirming, setConfirming] = useState<"accept" | "dismiss">();

	let confirmation = confirming === "accept"
		? {
			action: "Apply feedback",
			message: "Planner will use this feedback to update the document.",
			onConfirm: onAccept,
		}
		: confirming === "dismiss"
		? {
			action: "Dismiss",
			message: "This closes the thread without changing the document.",
			onConfirm: onDismiss,
		}
		: undefined;

	return (
		<SidecarCard
			data-plan-comment-card
			{...(inDocument
				? { "data-plan-comment-thread": thread.id }
				: { "data-plan-sidecar-thread": thread.id })}
			focused={focused}
			footer={!open && !applied && (
				<>
					<span className="text-sm text-warning-ink">Not yet applied</span>
					{canEdit && (
						<button
							className="btn btn-sm btn-ghost"
							disabled={busy}
							onClick={onRetry}
							type="button"
						>
							Ask again
						</button>
					)}
				</>
			)}
			label="Comment"
			onBlur={onBlur}
			onFocus={onFocus}
			onMouseEnter={onFocus}
			onMouseLeave={onBlur}
			settled={!open}
			status={!open && <Provenance at={thread.at} by={thread.resolver} verb="Accepted" />}
		>
			{onBack && (
				<button
					className="plan-comment-back btn btn-sm btn-ghost gap-1 self-start"
					data-plan-comment-back
					onClick={onBack}
					type="button"
				>
					<ChevronIcon aria-hidden="true" className="rotate-180" size={14} />
					{backLabel}
				</button>
			)}

			<ul className="m-0 flex list-none flex-col gap-2 p-0">
				{thread.notes.map((note, index) => (
					<Note
						action={index === 0 && showClose && onClose
							? <CloseButton onClose={onClose} />
							: undefined}
						key={note.id}
						note={note}
						opening={index === 0}
					/>
				))}
			</ul>

			{view.orphaned && <Quote drifted={view.drifted} text={quote} />}
			{view.drifted && !view.orphaned && (
				<p className="m-0 text-sm text-warning-ink">
					This passage has changed since the comment was added.
				</p>
			)}

			{writing && writing.length > 0 && (
				<p className="m-0 text-sm text-text-secondary">
					{writing.join(", ")} {writing.length === 1 ? "is" : "are"} writing…
				</p>
			)}

			{open && canEdit && (
				<>
					<Composer
						busy={busy}
						label="Reply"
						onSend={onReply}
						onTyping={onTyping}
						placeholder="Reply…"
					/>
					{confirmation
						? (
							<div className="plan-comment-confirm flex flex-col gap-2 pt-2">
								<p aria-live="polite" className="m-0 text-sm text-text-secondary">
									{confirmation.message}
								</p>
								<div className="flex items-center justify-between gap-2">
									<button
										className="btn btn-sm btn-ghost"
										onClick={() => setConfirming(undefined)}
										type="button"
									>
										Cancel
									</button>
									<button
										className="btn btn-sm btn-secondary"
										disabled={busy}
										onClick={() => {
											setConfirming(undefined);
											confirmation.onConfirm();
										}}
										type="button"
									>
										{confirmation.action}
									</button>
								</div>
							</div>
						)
						: (
							<div className="flex items-center justify-between gap-2 pt-2">
								<button
									className="btn btn-sm btn-ghost gap-1"
									disabled={busy}
									onClick={() => setConfirming("dismiss")}
									type="button"
								>
									<CloseIcon aria-hidden="true" size={14} />
									Dismiss
								</button>
								<button
									className="btn btn-md btn-primary gap-1"
									disabled={busy}
									onClick={() => setConfirming("accept")}
									type="button"
								>
									<CheckIcon aria-hidden="true" size={14} />
									Apply feedback
								</button>
							</div>
						)}
				</>
			)}
		</SidecarCard>
	);
}

export type ThreadListProps = {
	views: ThreadView[];
	/** A compact sheet focuses its own grabber instead. */
	autoFocus?: boolean;
	/** The thread just left with Back; its item takes focus, even in a sheet. */
	returnTo?: string;
	onSelect: (id: string) => void;
	onClose?: () => void;
	showClose?: boolean;
};

/** Several threads on one block, as one stop that opens into each of them. */
export function ThreadList(
	{ autoFocus = true, onClose, onSelect, returnTo, showClose = true, views }: ThreadListProps,
) {
	let list = useRef<HTMLUListElement>(null);

	useEffect(() => {
		let items = list.current;
		let item = returnTo
			? items?.querySelector<HTMLElement>(`[data-plan-comment-group-item="${returnTo}"]`)
			: undefined;
		if (item) item.focus();
		else if (autoFocus) {
			items?.querySelector<HTMLElement>("[data-plan-comment-group-item]")?.focus();
		}
		// Focus once, when the list opens; later changes to its threads leave focus where it is.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	let move = (event: KeyboardEvent<HTMLUListElement>) => {
		let items = Array.from(
			list.current?.querySelectorAll<HTMLElement>("[data-plan-comment-group-item]") ?? [],
		);
		let index = items.indexOf(document.activeElement as HTMLElement);
		let next = event.key === "ArrowDown"
			? (index + 1) % items.length
			: event.key === "ArrowUp"
			? (index - 1 + items.length) % items.length
			: event.key === "Home"
			? 0
			: event.key === "End"
			? items.length - 1
			: undefined;
		if (next === undefined || items.length === 0) return;
		event.preventDefault();
		items[next]?.focus();
	};

	return (
		<SidecarCard data-plan-comment-card data-plan-comment-group label="Comments" padded={false}>
			<header className="flex min-h-7 items-center justify-between px-3 pt-2.5">
				<span className="text-sm text-text-tertiary tabular-nums">
					{views.length} comments
				</span>
				{showClose && onClose && <CloseButton onClose={onClose} />}
			</header>
			<ul className="m-0 flex list-none flex-col p-1.5 pt-1" onKeyDown={move} ref={list}>
				{views.map(view => {
					let opening = view.thread.notes[0];
					let replies = Math.max(0, view.thread.notes.length - 1);
					return (
						<li key={view.thread.id}>
							<button
								className="plan-comment-group-item"
								data-plan-comment-group-item={view.thread.id}
								onClick={() => onSelect(view.thread.id)}
								type="button"
							>
								<span className="flex min-w-0 items-baseline justify-between gap-2">
									{opening && <Author handle={opening.handle} />}
									{replies > 0 && (
										<span className="text-xs text-text-tertiary tabular-nums">
											{replies} {replies === 1 ? "reply" : "replies"}
										</span>
									)}
								</span>
								<span className="plan-comment-group-note pl-7 text-sm text-text-secondary">
									{opening?.text.split("\n")[0]}
								</span>
							</button>
						</li>
					);
				})}
			</ul>
		</SidecarCard>
	);
}

export type DraftCardProps = {
	busy?: boolean;
	onSend: (text: string) => void;
	onCancel: () => void;
	showClose?: boolean;
};

/** A compact sheet shows its own close beside the grabber, so its draft has no header row. */
export function DraftCard({ busy, onCancel, onSend, showClose = true }: DraftCardProps) {
	return (
		<SidecarCard data-plan-comment-card focused label="Comment">
			{showClose && <DraftHeader onClose={onCancel} />}
			<Composer
				autoFocus
				busy={busy}
				label="Comment"
				onCancel={onCancel}
				onSend={onSend}
				placeholder="Comment on this passage…"
				sendLabel="Post comment"
			/>
		</SidecarCard>
	);
}
