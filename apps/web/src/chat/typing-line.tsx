import { useState } from "react";

import { ConnectingIndicator } from "../connecting-indicator";
import { announcement } from "./typists";

import type { Announcement, Typer } from "./typists";

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

/** What the live region says of one place: words only when who writes there changes. */
function useAnnouncement(typers: readonly Typer[], label?: string): string {
	let [said, setSaid] = useState<Announcement>();
	let next = announcement(said, typers, label);
	if (next !== said) setSaid(next);
	return next.text;
}

/**
 * The one polite live region for who is writing under Chat's composer and the open thread's. It is
 * always there and each place is its own part, said only when who writes there changes: not at a
 * keystroke, a repeated report, a new order or chopin's working row coming and going. With a thread
 * open beside Chat, each part names its conversation.
 */
export function TypingAnnouncer(
	{ chat, thread }: { chat: readonly Typer[]; thread?: readonly Typer[] },
) {
	let inChat = useAnnouncement(chat, thread ? "In Chat" : undefined);
	let inThread = useAnnouncement(thread ?? [], "In the thread");
	return (
		<p aria-live="polite" className="sr-only" data-chat-typing-announcer="" role="status">
			<span>{inChat}</span>
			<span>{thread ? inThread : ""}</span>
		</p>
	);
}
