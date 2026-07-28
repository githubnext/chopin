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

import { cursor } from "./cursor";

import type { KeyboardEvent } from "react";
import type { Comment } from "@chopin/protocol";
import type { ThreadView } from "./threads";

function when(ts: number): string {
	return new Date(ts * 1_000).toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

function Who({ handle }: { handle: string }) {
	return (
		<span
			className="text-xs font-semibold"
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
				<span className="text-[10px] text-muted-foreground">{when(note.ts)}</span>
			</div>
			<p className="m-0 text-sm whitespace-pre-wrap text-foreground">{note.text}</p>
		</li>
	);
}

/** The prose the thread marks, as a quotation the card can be read without. */
function Quote({ drifted, text }: { drifted?: boolean; text: string }) {
	return (
		<div className="flex flex-col gap-1">
			<blockquote className="m-0 border-l-2 border-border pl-2 text-xs text-muted-foreground italic">
				{text}
			</blockquote>
			{drifted && (
				<p className="m-0 text-[10px] text-warning">
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
				className="min-h-16 w-full resize-y rounded-md border border-input bg-background px-2 py-1.5 text-sm outline-none focus-visible:border-ring"
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
					className="rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground hover:bg-primary-hover disabled:opacity-50"
					disabled={!text.trim() || busy}
					onClick={send}
					type="button"
				>
					{label}
				</button>
				{onCancel && (
					<button
						className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
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
	label,
	onConfirm,
	tone,
}: {
	busy?: boolean;
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
		? "bg-primary text-primary-foreground hover:bg-primary-hover"
		: "text-muted-foreground hover:text-foreground";

	return (
		<button
			className={`rounded-md px-2 py-1 text-xs font-medium disabled:opacity-50 ${style}`}
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
	onTyping,
	quote,
	view,
	writing,
}: ThreadCardProps) {
	let { thread } = view;
	let open = thread.status === "open";

	return (
		<article
			className={`flex flex-col gap-2 overflow-hidden rounded-lg border bg-card p-3 ${
				focused ? "border-ring" : "border-border"
			}`}
			data-plan-sidecar-thread={thread.id}
			onBlur={onBlur}
			onFocus={onFocus}
			onMouseEnter={onFocus}
			onMouseLeave={onBlur}
		>
			<Quote drifted={view.drifted} text={quote} />

			<ul className="m-0 flex list-none flex-col gap-2 p-0">
				{thread.notes.map(note => <Note key={note.id} note={note} />)}
			</ul>

			{writing && writing.length > 0 && (
				<p className="m-0 text-[10px] text-muted-foreground">
					{writing.join(", ")} {writing.length === 1 ? "is" : "are"} writing…
				</p>
			)}

			{open
				? (
					<>
						<Composer
							busy={busy}
							label="Reply"
							onSend={onReply}
							onTyping={onTyping}
							placeholder="Reply…"
						/>
						<div className="flex items-center gap-2 border-t border-border pt-2">
							<Confirm busy={busy} label="Accept" onConfirm={onAccept} tone="primary" />
							<Confirm busy={busy} label="Dismiss" onConfirm={onDismiss} tone="quiet" />
							<span className="ml-auto text-[10px] text-muted-foreground">
								Accepting asks the agent to revise the plan
							</span>
						</div>
					</>
				)
				: (
					<footer className="flex items-center gap-2 border-t border-border pt-2">
						<span className="text-[10px] text-muted-foreground">
							Accepted by @{thread.resolver}
							{thread.at !== undefined && ` · ${when(thread.at)}`}
						</span>
						{!applied && (
							<>
								<span className="ml-auto text-[10px] text-warning">Not yet applied</span>
								<button
									className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
									disabled={busy}
									onClick={onRetry}
									type="button"
								>
									Ask again
								</button>
							</>
						)}
					</footer>
				)}
		</article>
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
		<article className="flex flex-col gap-2 overflow-hidden rounded-lg border border-ring bg-card p-3">
			<Quote text={quote} />
			<Composer
				autoFocus
				busy={busy}
				label="Comment"
				onCancel={onCancel}
				onSend={onSend}
				placeholder="Comment on this passage…"
			/>
		</article>
	);
}
