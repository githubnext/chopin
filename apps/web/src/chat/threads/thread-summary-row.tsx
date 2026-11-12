import { ChopinMark, Face } from "@chopin/editor";
import { ChevronIcon } from "@chopin/icons";
import { formatLastReplyAge, replyCountLabel, summaryParticipants } from "@chopin/protocol/threads";

import "./thread-summary-row.css";

import type { Chat } from "@chopin/protocol";

export function ThreadSummaryRow(
	{
		nowSeconds = Math.floor(Date.now() / 1000),
		onOpen,
		summary,
	}: {
		summary?: Chat.ThreadSummary;
		nowSeconds?: number;
		onOpen: (rootId: string) => void;
	},
) {
	if (!summary || summary.replyCount <= 0) return null;
	let avatars = summaryParticipants(summary.participants, 3);
	let countWords = replyCountLabel(summary.replyCount);
	let ageWords = formatLastReplyAge(summary.lastReplyTs, nowSeconds);

	return (
		<div>
			<button
				aria-label={`${countWords}, ${ageWords}`}
				className="chat-thread-summary-row"
				data-thread-summary={summary.rootId}
				onClick={() => onOpen(summary.rootId)}
				type="button"
			>
				<span aria-hidden="true" className="chat-thread-summary-avatars">
					{avatars.map((participant, index) =>
						participant.kind === "agent"
							? <ChopinMark circle key={`agent-${index}`} />
							: participant.kind === "member"
							? (
								<Face
									decorative
									handle={participant.handle}
									key={`member-${participant.handle}`}
									size={24}
									textSize="2xs"
									titled={false}
								/>
							)
							: null
					)}
				</span>
				<span className="chat-thread-summary-count">{countWords}</span>
				<span className="chat-thread-summary-age">{ageWords}</span>
				<span aria-hidden="true" className="chat-thread-summary-view">
					<span>View thread</span>
					<ChevronIcon size={12} />
				</span>
			</button>
		</div>
	);
}
