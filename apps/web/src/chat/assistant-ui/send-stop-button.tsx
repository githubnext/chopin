/**
 * The composer's one round button: assistant-ui's own `ComposerSend`, copied unmodified, driven by
 * Chopin's state through props (`send-stop.ts` decides which it is), and a polite live region that
 * says once when it turns from send into stop and back.
 */

import { useEffect, useRef, useState } from "react";

import { ComposerSend } from "@/components/assistant-ui/elements/composer";
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
	{ busy, hasDraft, onClick, state }: {
		/** A send is in flight: the button is busy, not merely disabled. */
		busy: boolean;
		hasDraft: boolean;
		onClick: () => void;
		state: SendStop;
	},
) {
	let spoken = useAnnouncement(state.action);
	return (
		<>
			{/* The disabled look is the element's own, from its attach button: no pointer, 30%. */}
			<ComposerSend
				aria-busy={busy || undefined}
				className="disabled:pointer-events-none disabled:opacity-30"
				disabled={state.disabled}
				idle={!hasDraft}
				onClick={onClick}
				streaming={state.action === "stop"}
				title={SEND_STOP_LABEL[state.action]}
			/>
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
