/**
 * A resolved comment thread, as its marker's popover shows it.
 *
 * Unpinned it previews the opening note and who resolved it; pinned it shows
 * every note, the resolver and Reopen. Where it sits and when it opens belong
 * to `ResolvedLayer`.
 */

import { CheckIcon, CloseIcon } from "@chopin/icons";

import { Note, stamp } from "./comments";
import { displayName } from "./display-name";
import { resolvedCommentMeta } from "./resolved";

import type { Comment } from "@chopin/protocol";

export type ResolvedCommentProps = {
	thread: Comment.Thread;
	pinned: boolean;
	close?: () => void;
	error?: string;
	onReopen?: () => void;
	pending?: boolean;
	/** A sheet has its own close in its header row. */
	sheet?: boolean;
};

export function ResolvedComment(
	{ close, error, onReopen, pending = false, pinned, sheet, thread }: ResolvedCommentProps,
) {
	let first = thread.notes[0];
	if (!pinned) {
		return (
			<div className="plan-resolved-comment">
				{first && (
					<ol className="plan-comment-notes">
						<Note note={first} />
					</ol>
				)}
				<p className="plan-resolved-comment-meta">
					{resolvedCommentMeta(
						{ notes: thread.notes.length, resolver: thread.resolver },
						displayName,
					).map((part, index) => (
						<span key={part}>
							{index > 0 && " "}
							{part}
						</span>
					))}
				</p>
			</div>
		);
	}
	let at = thread.at !== undefined ? stamp(thread.at) : "";
	return (
		<div className="plan-resolved-comment" data-pinned="">
			<div className="plan-resolved-comment-head">
				<p className="plan-resolved-comment-status">
					<CheckIcon aria-hidden="true" size={16} />
					<span>
						{thread.resolver ? `Resolved by ${displayName(thread.resolver)}` : "Resolved"}
					</span>
					{at && (
						<>
							{" "}
							<span>{at}</span>
						</>
					)}
				</p>
				{onReopen && (
					<button
						aria-disabled={pending || undefined}
						className="btn btn-sm btn-outline"
						// aria-disabled rather than disabled, so focus stays on the button while it works.
						onClick={() => !pending && onReopen()}
						type="button"
					>
						Reopen
					</button>
				)}
				{!sheet && (
					<button
						aria-label="Close"
						className="btn btn-icon btn-ghost plan-resolved-comment-close"
						data-plan-decision-close=""
						onClick={close}
						type="button"
					>
						<CloseIcon aria-hidden="true" size={16} />
					</button>
				)}
			</div>
			<ol className="plan-comment-notes">
				{thread.notes.map(note => <Note key={note.id} note={note} />)}
			</ol>
			{error && <p className="m-0 text-sm text-destructive-ink" role="alert">{error}</p>}
		</div>
	);
}
