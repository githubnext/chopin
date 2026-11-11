/**
 * What the composer's one round button is: send, or stop. assistant-ui's composer turns its send
 * button into a stop button while a reply runs; Chopin's composer stays live while a turn runs, so
 * a message typed meanwhile is sent as any other is, and the button follows the draft as well as the
 * Planner.
 */

export type SendStopAction = "send" | "stop";

export type SendStopInput = {
	/** The Planner has a turn or workflow runs going. */
	running: boolean;
	/** The draft has something in it besides white space. */
	hasDraft: boolean;
	/** Chat would send the draft now: it is not in flight, blocked or cut off. */
	canSend: boolean;
	/** This person may stop the Planner now, by Chat's own rules for Stop. */
	canStop: boolean;
};

export type SendStop = { action: SendStopAction; disabled: boolean };

/**
 * Stop appears only for a Planner that runs, an empty draft and a person who may stop it. Someone
 * who may not sees a disabled send, never a stop they cannot use; a draft with words keeps the send
 * and goes back to stop once it is sent or cleared.
 */
export function sendStop({ running, hasDraft, canSend, canStop }: SendStopInput): SendStop {
	if (running && !hasDraft && canStop) return { action: "stop", disabled: false };
	return { action: "send", disabled: !canSend };
}

/** The button's accessible name, which is also its tooltip: always the words of its icon. */
export const SEND_STOP_LABEL: Record<SendStopAction, string> = {
	send: "Send message",
	stop: "Stop generating",
};

/**
 * What a polite live region says when the button changes, and nothing otherwise: not as it first
 * appears, and not while the action stays what it was, however many tokens a reply streams.
 */
export function announcement(
	previous: SendStopAction | undefined,
	next: SendStopAction,
): string | undefined {
	if (previous === undefined || previous === next) return undefined;
	return SEND_STOP_LABEL[next];
}
