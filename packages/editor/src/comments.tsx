/**
 * A comment thread, as a card beside its passage.
 *
 * Two shapes. A draft has a passage but no thread yet, so it is only a
 * composer. An open thread lists its notes and takes replies from anyone; its
 * header actions copy a link to it or resolve it. Resolving hides the thread
 * at once and is undone from a toast, so it needs no confirmation.
 *
 * Accepted and dismissed threads come only from the earlier lifecycle and are
 * never shown here: an accepted one renders through its `<Decision>`.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowUpIcon, CheckIcon, ChevronIcon, EllipsisIcon, LinkIcon } from "@chopin/icons";

import { limits } from "@chopin/dialect";

import { displayName } from "./display-name";
import { Face } from "./face";
import { PRIMARY_COARSE_POINTER_QUERY } from "./pointer";

import type { KeyboardEvent, ReactNode } from "react";
import type { Comment } from "@chopin/protocol";
import type { ThreadView } from "./threads";

/** Notes past which the middle of a thread folds behind "Show N replies". */
const FOLD_AFTER = 3;

/** A time today, or a date otherwise: the shortest stamp that is still unambiguous. */
export function stamp(ts: number, now = new Date()): string {
	let date = new Date(ts * 1_000);
	if (Number.isNaN(date.getTime())) return "";
	let today = date.toDateString() === now.toDateString();
	return date.toLocaleString(
		undefined,
		today
			? { hour: "numeric", minute: "2-digit" }
			: {
				month: "short",
				day: "numeric",
				...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
			},
	);
}

/** Chat's author row: face, display name, quiet timestamp. The handle stays in the name. */
export function Author(
	{ handle, textSize = "sm", ts }: {
		handle: string;
		textSize?: "xs" | "sm";
		ts?: number;
	},
) {
	return (
		<span
			className={`flex min-w-0 items-center gap-2 ${textSize === "xs" ? "text-xs" : "text-sm"}`}
		>
			<Face decorative handle={handle} size={20} titled={false} />
			<span className="min-w-0 truncate font-semibold text-text-primary" title={`@${handle}`}>
				{displayName(handle)}
				<span className="sr-only">(@{handle})</span>
			</span>
			{ts !== undefined && (
				<time
					className="shrink-0 text-xs text-text-quaternary tabular-nums"
					dateTime={new Date(ts * 1_000).toISOString()}
				>
					{stamp(ts)}
				</time>
			)}
		</span>
	);
}

function Note({ actions, note }: { actions?: ReactNode; note: Comment.Note }) {
	return (
		<li className="plan-comment-note">
			<div className="plan-comment-note-head">
				<Author handle={note.handle} ts={note.ts} />
				{actions}
			</div>
			<p className="plan-comment-note-body">{note.text}</p>
		</li>
	);
}

/** The `…` menu and the resolve check, revealed on hover or focus and always shown on touch. */
function Actions({ link, onResolve }: { link?: string; onResolve?: () => void }) {
	let [menu, setMenu] = useState(false);
	let trigger = useRef<HTMLButtonElement>(null);
	let list = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!menu) return;
		list.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
		let outside = (event: PointerEvent) => {
			let target = event.target as Node;
			if (!list.current?.contains(target) && !trigger.current?.contains(target)) setMenu(false);
		};
		document.addEventListener("pointerdown", outside);
		return () => document.removeEventListener("pointerdown", outside);
	}, [menu]);

	let close = () => {
		setMenu(false);
		trigger.current?.focus();
	};

	return (
		<div className="plan-comment-actions" data-open={menu || undefined}>
			{link && (
				<span className="plan-comment-menu-anchor">
					<button
						aria-expanded={menu}
						aria-haspopup="menu"
						aria-label="More actions"
						className="plan-comment-action btn btn-icon btn-ghost"
						data-press="small"
						onClick={() => setMenu(open => !open)}
						ref={trigger}
						type="button"
					>
						<EllipsisIcon aria-hidden="true" size={14} />
					</button>
					{menu && (
						<div
							aria-label="Comment actions"
							className="plan-comment-menu"
							onKeyDown={event => {
								if (event.key !== "Escape" && event.key !== "Tab") return;
								// The card's own Escape would close it; this only closes the menu.
								if (event.key === "Escape") {
									event.preventDefault();
									event.stopPropagation();
								}
								close();
							}}
							ref={list}
							role="menu"
						>
							<button
								className="plan-comment-menu-item"
								onClick={() => {
									void navigator.clipboard?.writeText(link).catch(() => {});
									close();
								}}
								role="menuitem"
								type="button"
							>
								<LinkIcon aria-hidden="true" size={14} />
								Copy link
							</button>
						</div>
					)}
				</span>
			)}
			{onResolve && (
				<button
					aria-label="Resolve"
					className="plan-comment-action btn btn-icon btn-ghost"
					data-press="small"
					data-tooltip="Resolve"
					onClick={onResolve}
					type="button"
				>
					<CheckIcon aria-hidden="true" size={14} />
				</button>
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

/**
 * The field and its send, shared by new comments and replies.
 *
 * A new comment has a footer row whose leading side is left empty for the
 * options a send can carry. A reply is one quiet line; focus or text shows its
 * send inline at the end of the line, and the field grows only with its text.
 */
function Composer({
	autoFocus,
	mode,
	onCancel,
	onSend,
	onTyping,
}: {
	autoFocus?: boolean;
	mode: "new" | "reply";
	onCancel?: () => void;
	onSend: (text: string) => void;
	onTyping?: (writing: boolean) => void;
}) {
	let [text, setText] = useState("");
	let [focused, setFocused] = useState(false);
	let [coarse, setCoarse] = useState(false);
	let ref = useRef<HTMLTextAreaElement>(null);

	useEffect(() => {
		setCoarse(matchMedia(PRIMARY_COARSE_POINTER_QUERY).matches);
		if (autoFocus) ref.current?.focus({ preventScroll: true });
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
	// an unmount does not leave a caret blinking in somebody else's card.
	useEffect(() => () => onTyping?.(false), [onTyping]);

	let send = () => {
		let value = text.trim();
		if (!value) return;
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
			coarse,
		);
		if (action === "cancel" && onCancel) {
			event.preventDefault();
			onCancel();
		} else if (action === "send") {
			event.preventDefault();
			send();
		}
	};

	let open = mode === "new" || focused || text.length > 0;
	let label = mode === "new" ? "Post comment" : "Send reply";
	let action = (
		<button
			aria-label={label}
			className="plan-comment-send btn btn-icon btn-primary rounded-full"
			data-press="small"
			data-tooltip="Send"
			data-tooltip-shortcut={coarse ? undefined : "↵"}
			disabled={!text.trim()}
			hidden={!open}
			onClick={send}
			type="button"
		>
			<ArrowUpIcon aria-hidden="true" size={14} />
		</button>
	);

	return (
		<div
			className="plan-comment-composer field"
			data-mode={mode}
			data-open={open || undefined}
			onBlur={event => {
				if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
			}}
			onFocus={() => setFocused(true)}
		>
			<textarea
				aria-label={mode === "new" ? "Comment" : "Reply"}
				className="plan-comment-composer-field"
				maxLength={limits.MAX_NOTE}
				onChange={event => {
					setText(event.target.value);
					onTyping?.(event.target.value.length > 0);
				}}
				onKeyDown={key}
				placeholder={mode === "new" ? "Add a comment" : "Reply"}
				ref={ref}
				rows={1}
				value={text}
			/>
			{mode === "new"
				? (
					<div className="plan-comment-composer-fold">
						<div className="plan-comment-composer-footer">{action}</div>
					</div>
				)
				: action}
		</div>
	);
}

export type ThreadCardProps = {
	view: ThreadView;
	quote: string;
	writing?: string[];
	/** Whether durable thread actions are available to this viewer. */
	canEdit?: boolean;
	/** An address that opens this thread, for Copy link. */
	link?: string;
	onReply: (text: string) => void;
	onResolve: () => void;
	onTyping: (writing: boolean) => void;
	onFocus: () => void;
	onBlur: () => void;
	/** Return to the list of a block's threads this one was opened from. */
	onBack?: () => void;
	backLabel?: string;
};

export function ThreadCard({
	backLabel,
	canEdit = true,
	link,
	onBack,
	onBlur,
	onFocus,
	onReply,
	onResolve,
	onTyping,
	quote,
	view,
	writing,
}: ThreadCardProps) {
	let { thread } = view;
	let [unfolded, setUnfolded] = useState(false);
	let notes = thread.notes;
	let first = notes[0];
	let folded = notes.length > FOLD_AFTER && !unfolded;
	let rest = folded ? notes.slice(-1) : notes.slice(1);
	let hidden = notes.length - 2;

	return (
		<article
			aria-label="Comment"
			className="plan-comment-thread"
			data-focus-boundary=""
			data-plan-comment-card
			data-plan-comment-thread={thread.id}
			onBlur={onBlur}
			onFocus={onFocus}
			onMouseEnter={onFocus}
			onMouseLeave={onBlur}
		>
			{onBack && (
				<button
					className="plan-comment-back btn btn-sm btn-ghost gap-1"
					data-plan-comment-back
					onClick={onBack}
					type="button"
				>
					<ChevronIcon aria-hidden="true" className="rotate-180" size={14} />
					{backLabel}
				</button>
			)}

			<ol className="plan-comment-notes">
				{first && (
					<Note
						actions={canEdit || link
							? <Actions link={link} onResolve={canEdit ? onResolve : undefined} />
							: undefined}
						note={first}
					/>
				)}
				{folded && (
					<li>
						<button
							className="plan-comment-more"
							onClick={() => setUnfolded(true)}
							type="button"
						>
							<span aria-hidden="true" className="plan-comment-more-rule" />
							Show {hidden} {hidden === 1 ? "reply" : "replies"}
							<span aria-hidden="true" className="plan-comment-more-rule" />
						</button>
					</li>
				)}
				{rest.map(note => <Note key={note.id} note={note} />)}
			</ol>

			{(view.orphaned || view.drifted) && (
				<div className="plan-comment-context" data-plan-comment-context>
					{view.orphaned && (
						<blockquote className="plan-comment-context-copy m-0 text-sm text-text-secondary">
							{quote}
						</blockquote>
					)}
					<p className="m-0 text-sm text-warning-ink">
						This passage has changed since the comment was added.
					</p>
				</div>
			)}

			{writing && writing.length > 0 && (
				<p className="m-0 text-sm text-text-secondary">
					{writing.join(", ")} {writing.length === 1 ? "is" : "are"} writing…
				</p>
			)}

			{canEdit && <Composer mode="reply" onSend={onReply} onTyping={onTyping} />}
		</article>
	);
}

export type ThreadListProps = {
	views: ThreadView[];
	/** A compact sheet focuses its own grabber instead. */
	autoFocus?: boolean;
	/** The thread just left with Back; its item takes focus, even in a sheet. */
	returnTo?: string;
	onSelect: (id: string) => void;
};

/** Several threads on one block, as one stop that opens into each of them. */
export function ThreadList({ autoFocus = true, onSelect, returnTo, views }: ThreadListProps) {
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
		<article
			aria-label="Comments"
			className="plan-comment-thread plan-comment-list"
			data-focus-boundary=""
			data-plan-comment-card
			data-plan-comment-group
		>
			<header className="plan-comment-list-head">{views.length} comments</header>
			<ul className="plan-comment-list-items" onKeyDown={move} ref={list}>
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
								<span className="plan-comment-note-head">
									{opening && <Author handle={opening.handle} ts={opening.ts} />}
									{replies > 0 && (
										<span className="plan-comment-group-replies">
											{replies} {replies === 1 ? "reply" : "replies"}
										</span>
									)}
								</span>
								<span className="plan-comment-group-note">{opening?.text}</span>
							</button>
						</li>
					);
				})}
			</ul>
		</article>
	);
}

export type DraftCardProps = {
	onSend: (text: string) => void;
	onCancel: () => void;
};

/** A new comment: only the composer, with no header to say what the card already shows. */
export function DraftCard({ onCancel, onSend }: DraftCardProps) {
	return (
		<article
			aria-label="New comment"
			className="plan-comment-thread"
			data-focus-boundary=""
			data-plan-comment-card
			data-plan-comment-draft
		>
			<Composer autoFocus mode="new" onCancel={onCancel} onSend={onSend} />
		</article>
	);
}
