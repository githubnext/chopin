import { reactedBy, reactionHint } from "../reactions";

import type { Chat } from "@chopin/protocol";

export function ReactionPills(
	{ handle, onToggle, pending, reactions }: {
		handle: string;
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
		</div>
	);
}
