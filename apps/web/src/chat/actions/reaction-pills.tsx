import { ReactionAddIcon } from "@chopin/icons";

import { reactedBy, reactionHint } from "../reactions";

import "./message-actions.css";

import type { Chat } from "@chopin/protocol";

export function ReactionPills(
	{ handle, onAdd, onToggle, pending, reactions }: {
		handle: string;
		/** Opens the message's emoji picker, from the add pill a pointer finds after the reactions. */
		onAdd?: () => void;
		onToggle: (emoji: string, on: boolean) => void;
		pending: ReadonlySet<string>;
		reactions: readonly Chat.Reaction[];
	},
) {
	return (
		<div aria-label="Reactions" className="chat-reactions" role="group">
			{reactions.map(reaction => {
				let own = reactedBy(reaction, handle);
				let hint = reactionHint(reaction, handle);
				return (
					<button
						aria-label={hint}
						aria-pressed={own}
						className="chat-reaction"
						data-chat-reaction={reaction.emoji}
						data-tooltip={hint}
						data-tooltip-detail=""
						data-tooltip-verbatim=""
						data-pending={pending.has(reaction.emoji) || undefined}
						key={reaction.emoji}
						onClick={() => onToggle(reaction.emoji, !own)}
						type="button"
					>
						<span aria-hidden="true" className="chat-reaction-emoji">{reaction.emoji}</span>
						<span aria-hidden="true" className="chat-reaction-count">
							{reaction.handles.length}
						</span>
					</button>
				);
			})}
			{onAdd && (
				// The toolbar's Add reaction is the one a keyboard and a screen reader reach; this is its
				// shortcut for a pointer, as Slack shows after a message's reactions on hover.
				<button
					aria-hidden="true"
					className="chat-reaction chat-reaction-add"
					onClick={onAdd}
					tabIndex={-1}
					type="button"
				>
					<ReactionAddIcon aria-hidden="true" />
				</button>
			)}
		</div>
	);
}

/** What a message says of a reaction the server turned down. */
export function ReactionRefusal({ text }: { text: string }) {
	return (
		<p className="chat-reaction-refusal" data-chat-reaction-refused="" role="status">
			<span className="chat-reaction-refusal-title">Couldn't react.</span> {text}
		</p>
	);
}
