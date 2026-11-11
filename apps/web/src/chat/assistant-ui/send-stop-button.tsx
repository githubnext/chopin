/**
 * The message box's one send control: a filled, rounded-square primary button with a paper plane,
 * which is a stop (a square) by the rule in `send-stop.ts`, and a polite live region that says once
 * when it turns from send into stop and back. Chopin's state drives it through props.
 */

import { useEffect, useRef, useState } from "react";

import { SendIcon, StopIcon } from "@chopin/icons";
import { announcement, SEND_STOP_LABEL } from "./send-stop";

import type { SendStop, SendStopAction } from "./send-stop";

/**
 * What a screen reader hears, one entry per change of action. Held in state so the text stays put
 * between changes, whatever re-renders the composer for each token of a reply.
 */
function useAnnouncement(action: SendStopAction): { id: number; text: string } | undefined {
	let previous = useRef<SendStopAction>(undefined);
	let [spoken, setSpoken] = useState<{ id: number; text: string }>();
	useEffect(() => {
		let text = announcement(previous.current, action);
		previous.current = action;
		if (text) setSpoken(current => ({ id: (current?.id ?? 0) + 1, text }));
	}, [action]);
	return spoken;
}

export function SendStopButton(
	{ busy, onClick, state }: {
		/** A send is in flight: the button is busy, not merely disabled. */
		busy: boolean;
		onClick: () => void;
		state: SendStop;
	},
) {
	let spoken = useAnnouncement(state.action);
	let label = SEND_STOP_LABEL[state.action];
	return (
		<>
			<button
				aria-busy={busy || undefined}
				aria-label={label}
				className="btn btn-icon btn-primary composer-send"
				data-send-stop={state.action}
				disabled={state.disabled}
				onClick={onClick}
				title={label}
				type="button"
			>
				{state.action === "stop"
					? <StopIcon aria-hidden="true" size={16} />
					: <SendIcon aria-hidden="true" size={16} />}
			</button>
			<span
				aria-atomic="true"
				aria-live="polite"
				className="sr-only"
				data-send-stop-status=""
				role="status"
			>
				{/* A new node each time, so the same words said twice are heard twice. */}
				{spoken && <span key={spoken.id}>{spoken.text}</span>}
			</span>
		</>
	);
}
