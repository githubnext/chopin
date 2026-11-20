import { ConnectingIndicator } from "../connecting-indicator";

import "./typing-line.css";

/**
 * Slack's typing line under a composer: the dots and who is writing (`typingWords`), in the
 * tertiary ink. Chat's one live region (`TypingAnnouncer`) says it, so it has no live role.
 */
export function TypingLine({ words }: { words: string }) {
	return (
		<p className="chat-typing" data-chat-typing="">
			{words && (
				<>
					<ConnectingIndicator className="chat-typing-dots" />
					<span className="chat-typing-words">{words}</span>
				</>
			)}
		</p>
	);
}

/**
 * The one polite live region for who is writing under Chat's composer and the open thread's. It is
 * always there and each place is its own part, so a change of who writes in one place is said once
 * and alone, and words that stay the same while the same people write say nothing at a keystroke.
 */
export function TypingAnnouncer({ chat, thread }: { chat: string; thread?: string }) {
	return (
		<p aria-live="polite" className="sr-only" data-chat-typing-announcer="" role="status">
			<span>{chat}</span>
			<span>{thread ? `In the thread, ${thread}` : ""}</span>
		</p>
	);
}
