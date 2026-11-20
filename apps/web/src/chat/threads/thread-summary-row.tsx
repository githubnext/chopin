import { ChopinMark, Face } from "@chopin/editor";
import { ChevronIcon } from "@chopin/icons";
import { formatLastReplyAge, replyCountLabel, summaryParticipants } from "@chopin/protocol/threads";

import { ConnectingIndicator } from "../../connecting-indicator";

import "../typing-line.css";
import "./thread-summary-row.css";

import type { Chat } from "@chopin/protocol";

/**
 * Slack's reply bar under a Chat message with a thread. While someone writes in the thread,
 * `replying` (_@ana is replying…_) takes the place of the last reply's age; a thread with no reply
 * yet shows the bar with only that line, which opens the thread as the bar does.
 */
export function ThreadSummaryRow(
	{
		nowSeconds = Math.floor(Date.now() / 1000),
		onOpen,
		replying,
		rootId,
		summary,
	}: {
		summary?: Chat.ThreadSummary;
		rootId: string;
		replying?: string;
		nowSeconds?: number;
		onOpen: (rootId: string) => void;
	},
) {
	let replied = !!summary && summary.replyCount > 0;
	if (!replied && !replying) return null;
	let avatars = replied ? summaryParticipants(summary!.participants, 3) : [];
	let countWords = replied ? replyCountLabel(summary!.replyCount) : undefined;
	let ageWords = replied ? formatLastReplyAge(summary!.lastReplyTs, nowSeconds) : undefined;
	let status = replying || ageWords!;

	return (
		<div>
			<button
				aria-label={countWords ? `${countWords}, ${status}` : status}
				className="chat-thread-summary-row"
				data-thread-replying={replying ? "" : undefined}
				data-thread-summary={rootId}
				onClick={() => onOpen(rootId)}
				type="button"
			>
				{avatars.length > 0 && (
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
				)}
				{countWords && <span className="chat-thread-summary-count">{countWords}</span>}
				{replying
					? (
						<span className="chat-thread-summary-replying">
							<ConnectingIndicator className="chat-typing-dots" />
							{replying}
						</span>
					)
					: <span className="chat-thread-summary-age">{ageWords}</span>}
				<span aria-hidden="true" className="chat-thread-summary-view">
					<span>View thread</span>
					<ChevronIcon size={12} />
				</span>
			</button>
		</div>
	);
}
