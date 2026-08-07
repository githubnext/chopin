/**
 * A comment thread, as a card in the sidecar.
 *
 * Four states, and the difference between them is who can still act. A draft
 * has a passage but no thread yet. An open thread takes replies from anyone.
 * An accepted one is frozen — that is what accepting means — and reads as a
 * decision. A dismissed one is not rendered at all.
 *
 * Accept and dismiss both confirm on a second click, because neither can be
 * undone: accepting freezes the thread, puts a decision in the plan and starts
 * a turn. That is the same two-click shape `QuestionView` uses for cancelling,
 * so it is an interaction people have already met here.
 */

import { useEffect, useRef, useState } from "react";

import { limits } from "@chopin/dialect";

import { Provenance, SidecarCard, when } from "./card";
import { Count } from "./count";
import { cursor } from "./cursor";

import type { KeyboardEvent } from "react";
import type { Comment } from "@chopin/protocol";
import type { ThreadView } from "./threads";

function Who({ handle }: { handle: string }) {
	return (
		<span
			className="text-sm font-semibold"
			style={{ color: cursor(handle).color }}
		>
			@{handle}
		</span>
	);
}

function Note({ note }: { note: Comment.Note }) {
	return (
		<li className="flex flex-col gap-0.5">
			<div className="flex items-baseline gap-2">
				<Who handle={note.handle} />
				<span className="text-sm text-text-tertiary tabular-nums">{when(note.ts)}</span>
			</div>
			<p className="m-0 text-base whitespace-pre-wrap text-text-primary">{note.text}</p>
		</li>
	);
}

const QUOTED = "m-0 w-full text-left text-sm text-text-secondary italic";

/**
 * The prose the thread marks, as a quotation the card can be read without.
 *
 * A button when there is somewhere to go, a blockquote when there is not —
 * which is the rule `QuestionView` already applies to an answer, so both halves
 * of the sidecar offer the same thing in the same way. A real element carries
 * the affordance and the keyboard handling rather than a quotation pretending
 * to be one, and a drifted thread offers no jump it could not honour: the card
 * still reads, which is the durable part of a comment.
 *
 * The quote rather than the card. A card holds a reply box, an Accept and a
 * Dismiss; making the whole of it a link would mean deciding, on every click,
 * whether the reader meant the link or the control they actually hit.
 */
function Quote(
	{ count = 0, drifted, onSelect, text }: {
		count?: number;
		drifted?: boolean;
		onSelect?: () => void;
		text: string;
	},
) {
	return (
		<div className="flex flex-col gap-1">
			{count > 0 && onSelect
				? (
					<button
						// The quote is part of the name, not replaced by it: it is the
						// only place the marked phrase appears on the card, so a label
						// saying only where the button goes would take it away from
						// anybody who cannot see it.
						aria-label={count > 1
							? `${text} — show in plan, ${count} places`
							: `${text} — show in plan`}
						className={`${QUOTED} cursor-pointer rounded-sm hover:text-text-primary`}
						data-press="wide"
						onClick={onSelect}
						type="button"
					>
						{text}
						{/* The label above already says how many places, so the pill is decoration. */}
						{count > 1 && (
							<span aria-hidden="true" className="ml-1.5 align-middle not-italic">
								<Count>{count}</Count>
							</span>
						)}
					</button>
				)
				: <blockquote className={QUOTED}>{text}</blockquote>}
			{drifted && (
				<p className="m-0 text-sm text-warning-ink">
					The text this refers to has changed.
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
}: {
	autoFocus?: boolean;
	busy?: boolean;
	label: string;
	onCancel?: () => void;
	onSend: (text: string) => void;
	onTyping?: (writing: boolean) => void;
	placeholder: string;
}) {
	let [text, setText] = useState("");
	let ref = useRef<HTMLTextAreaElement>(null);

	useEffect(() => {
		if (autoFocus) ref.current?.focus();
	}, [autoFocus]);

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
		if (event.key === "Escape" && onCancel) return onCancel();
		if (event.key !== "Enter" || event.shiftKey) return;
		event.preventDefault();
		send();
	};

	return (
		<div className="flex flex-col gap-1.5">
			<textarea
				ref={ref}
				className="min-h-16 w-full resize-y rounded-md control-edge bg-page px-2 py-1.5 text-sm focus-visible:border-brand"
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
			<div className="flex items-center gap-2">
				<button
					className="rounded-md bg-brand px-2 py-1 text-sm font-medium text-white hover:bg-brand-hover disabled:opacity-50"
					disabled={!text.trim() || busy}
					onClick={send}
					type="button"
				>
					{label}
				</button>
				{onCancel && (
					<button
						className="rounded-md px-2 py-1 text-sm text-text-tertiary hover:text-text-primary"
						onClick={onCancel}
						type="button"
					>
						Cancel
					</button>
				)}
			</div>
		</div>
	);
}

/** A button that asks again before doing something that cannot be undone. */
function Confirm({
	busy,
	consequence,
	label,
	onConfirm,
	tone,
}: {
	busy?: boolean;
	consequence?: string;
	label: string;
	onConfirm: () => void;
	tone: "primary" | "quiet";
}) {
	let [asked, setAsked] = useState(false);

	useEffect(() => {
		if (!asked) return;
		let timer = setTimeout(() => setAsked(false), 4_000);
		return () => clearTimeout(timer);
	}, [asked]);

	let style = tone === "primary"
		? "bg-brand text-white hover:bg-brand-hover"
		: "text-text-tertiary hover:text-text-primary";

	return (
		<>
			<button
				className={`rounded-md px-2 py-1 text-sm font-medium disabled:opacity-50 ${style}`}
				disabled={busy}
				onClick={() => {
					if (!asked) return setAsked(true);
					setAsked(false);
					onConfirm();
				}}
				type="button"
			>
				{asked ? "Sure?" : label}
			</button>
			{consequence && (
				// Keep the live region mounted so later text changes are announced.
				<span aria-live="polite" className="order-last ml-auto text-sm text-text-secondary">
					{asked && consequence}
				</span>
			)}
		</>
	);
}

export type ThreadCardProps = {
	view: ThreadView;
	quote: string;
	writing?: string[];
	focused?: boolean;
	busy?: boolean;
	/** True once the agent has said what an accepted thread produced. */
	applied?: boolean;
	onReply: (text: string) => void;
	onAccept: () => void;
	onDismiss: () => void;
	onRetry: () => void;
	onTyping: (writing: boolean) => void;
	onFocus: () => void;
	onBlur: () => void;
	/** Take the reader to the prose this points at. */
	onReveal: () => void;
};

export function ThreadCard({
	applied,
	busy,
	focused,
	onAccept,
	onBlur,
	onDismiss,
	onFocus,
	onReply,
	onRetry,
	onReveal,
	onTyping,
	quote,
	view,
	writing,
}: ThreadCardProps) {
	let { thread } = view;
	let open = thread.status === "open";

	return (
		<SidecarCard
			data-plan-sidecar-thread={thread.id}
			focused={focused}
			footer={!open && !applied && (
				<>
					<span className="text-sm text-warning-ink">Not yet applied</span>
					<button
						className="rounded-md px-2 py-1 text-sm text-text-tertiary hover:text-text-primary"
						disabled={busy}
						onClick={onRetry}
						type="button"
					>
						Ask again
					</button>
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
			<Quote count={view.places.length} drifted={view.drifted} onSelect={onReveal} text={quote} />

			<ul className="m-0 flex list-none flex-col gap-2 p-0">
				{thread.notes.map(note => <Note key={note.id} note={note} />)}
			</ul>

			{writing && writing.length > 0 && (
				<p className="m-0 text-sm text-text-secondary">
					{writing.join(", ")} {writing.length === 1 ? "is" : "are"} writing…
				</p>
			)}

			{open && (
				<>
					<Composer
						busy={busy}
						label="Reply"
						onSend={onReply}
						onTyping={onTyping}
						placeholder="Reply…"
					/>
					<div className="flex items-center gap-2 pt-2">
						<Confirm
							busy={busy}
							consequence="Accepting asks the agent to revise the plan"
							label="Accept"
							onConfirm={onAccept}
							tone="primary"
						/>
						<Confirm busy={busy} label="Dismiss" onConfirm={onDismiss} tone="quiet" />
					</div>
				</>
			)}
		</SidecarCard>
	);
}

export type DraftCardProps = {
	quote: string;
	busy?: boolean;
	onSend: (text: string) => void;
	onCancel: () => void;
};

export function DraftCard({ busy, onCancel, onSend, quote }: DraftCardProps) {
	return (
		<SidecarCard focused label="Comment">
			<Quote text={quote} />
			<Composer
				autoFocus
				busy={busy}
				label="Comment"
				onCancel={onCancel}
				onSend={onSend}
				placeholder="Comment on this passage…"
			/>
		</SidecarCard>
	);
}
