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
import { ArrowUpIcon, ChatCircleIcon, CheckIcon, XIcon } from "@phosphor-icons/react";

import { limits } from "@chopin/dialect";

import { Provenance, SidecarCard, when } from "./card";

import type { KeyboardEvent, ReactNode } from "react";
import type { Comment } from "@chopin/protocol";
import type { ThreadView } from "./threads";

function Who({ handle }: { handle: string }) {
	return (
		<span className="text-sm font-semibold text-brand-ink">
			@{handle}
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
				<div className="flex min-w-0 items-baseline gap-2">
					<Who handle={note.handle} />
					<span className="truncate text-sm text-text-tertiary tabular-nums">
						{when(note.ts)}
					</span>
				</div>
				{action}
			</div>
			<p className="m-0 text-sm whitespace-pre-wrap text-text-primary">{note.text}</p>
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
			<XIcon aria-hidden="true" size={16} />
		</button>
	);
}

function DraftHeader({ onClose, showClose }: { onClose: () => void; showClose: boolean }) {
	return (
		<header
			className="flex min-h-7 items-center justify-between text-text-tertiary"
			data-plan-comment-draft-header
		>
			<ChatCircleIcon aria-hidden="true" size={16} />
			{showClose && <CloseButton onClose={onClose} />}
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
 * A textarea that submits on Enter.
 *
 * Shift-Enter is a newline, which is the convention every chat surface uses and
 * the one the composer next door already follows.
 */
function Composer({
	autoFocus,
	busy,
	label,
	onCancel,
	onSend,
	onTyping,
	placeholder,
	insetSend,
	sendLabel,
}: {
	autoFocus?: boolean;
	busy?: boolean;
	label: string;
	onCancel?: () => void;
	onSend: (text: string) => void;
	onTyping?: (writing: boolean) => void;
	placeholder: string;
	insetSend?: boolean;
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
		if (event.key === "Escape" && onCancel) {
			event.preventDefault();
			return onCancel();
		}
		if (event.key !== "Enter" || event.shiftKey) return;
		event.preventDefault();
		send();
	};

	return (
		<div className="flex flex-col gap-1.5">
			<div
				className="plan-comment-composer relative"
				data-inset-send={insetSend || undefined}
				data-plan-comment-composer-shell={insetSend || undefined}
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
				{insetSend && (
					<button
						aria-label={sendLabel ?? `Send ${label.toLowerCase()}`}
						className="plan-comment-send btn btn-icon btn-primary absolute right-2 bottom-2 rounded-full"
						disabled={!text.trim() || busy}
						onClick={send}
						title={sendLabel ?? `Send ${label.toLowerCase()}`}
						type="button"
					>
						<ArrowUpIcon aria-hidden="true" size={14} weight="bold" />
					</button>
				)}
				{onCancel && (
					<div className="mt-1.5 flex items-center gap-2">
						<button
							className="btn btn-sm btn-primary"
							data-plan-comment-submit
							disabled={!text.trim() || busy}
							onClick={send}
							type="button"
						>
							{label}
						</button>
						<button
							className="btn btn-sm btn-secondary"
							onClick={onCancel}
							type="button"
						>
							Cancel
						</button>
					</div>
				)}
			</div>
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
						insetSend
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
									<XIcon aria-hidden="true" size={14} />
									Dismiss
								</button>
								<button
									className="btn btn-md btn-primary gap-1"
									disabled={busy}
									onClick={() => setConfirming("accept")}
									type="button"
								>
									<CheckIcon aria-hidden="true" size={14} weight="bold" />
									Apply feedback
								</button>
							</div>
						)}
				</>
			)}
		</SidecarCard>
	);
}

export type DraftCardProps = {
	busy?: boolean;
	onSend: (text: string) => void;
	onCancel: () => void;
	showClose?: boolean;
};

export function DraftCard({ busy, onCancel, onSend, showClose = true }: DraftCardProps) {
	return (
		<SidecarCard data-plan-comment-card focused label="Comment">
			<DraftHeader onClose={onCancel} showClose={showClose} />
			<Composer
				autoFocus
				busy={busy}
				insetSend={!showClose}
				label="Comment"
				onCancel={showClose ? onCancel : undefined}
				onSend={onSend}
				placeholder="Comment on this passage…"
				sendLabel="Post comment"
			/>
		</SidecarCard>
	);
}
