/**
 * What the failure banner says and offers, as plain decisions.
 *
 * Two things feed it: a Planner turn that ended without finishing its reply (the server's system
 * notice carries a structured `turnFailure`), and a refused room message. Both are the one failure
 * family of `ErrorState`. A machine whose connection dropped under a reply is not one of them: it
 * is the connection's to tell (`connection-phase.ts`), so one cause never shows two banners.
 * The words are a machine's and a person's own, none of Chopin's terms (`status-copy.test.tsx`).
 */

import { referenceRequest } from "./references";

import type { Chat } from "@chopin/protocol";
import type { ChatSendPayload, SendFailure } from "./references";

export type FailureKind = Exclude<Chat.TurnFailure["kind"], "dropped"> | "send";

export type FailureView = {
	kind: FailureKind;
	title: string;
	/** The machine's or server's own words, exactly as reported. */
	detail?: string;
	link?: { label: string; href: string };
	/** Whether sending the same turn again can help. */
	retry: boolean;
};

const TITLE: Record<Exclude<Chat.TurnFailure["kind"], "dropped">, string> = {
	error: "Couldn't finish the reply.",
	refused: "The reply stopped: it needed something it isn't allowed to use.",
	tool: "The reply stopped: a tool it needed isn't available.",
	"timed-out": "The reply took too long.",
	unreachable: "Couldn't reach the agent to reply.",
};

/** Whether sending the same turn again can help: not for one that was refused, which would be again. */
const RETRYABLE: Record<Exclude<Chat.TurnFailure["kind"], "dropped">, boolean> = {
	error: true,
	refused: false,
	tool: true,
	"timed-out": true,
	unreachable: true,
};

export function failureView(failure: Chat.TurnFailure): FailureView | undefined {
	if (failure.kind === "dropped") return undefined;
	return {
		kind: failure.kind,
		title: TITLE[failure.kind],
		...(failure.detail ? { detail: failure.detail } : {}),
		retry: RETRYABLE[failure.kind],
	};
}

/**
 * The refused room message, in the server's words. Where no machine took it, sending it again
 * cannot help, so the action that can is offered instead: where to look at the machines.
 */
export function sendFailureView(
	failure: Pick<SendFailure, "text">,
	code: string | undefined,
): FailureView {
	return {
		kind: "send",
		title: failure.text,
		retry: code !== "planner-not-attached",
		...(code === "planner-not-attached"
			? { link: { label: "Open machines", href: "/machines" } }
			: {}),
	};
}

export type FailureBanner = FailureView & {
	/** The failed turn's notice in the transcript, which the banner stands in for. */
	entry: string;
};

/**
 * The failed reply the banner tells now: the latest failed turn, until anyone says something
 * after it (a member or the agent has moved on) or a reply is running (a new turn). A system
 * notice after it, such as a pause, does not end it. `retry` is also false unless this person
 * asked for the reply that failed, in a message that was sent to the Planner: nobody sends
 * another's words again.
 */
export function failureBanner(
	entries: readonly Chat.Entry[],
	turn: Chat.Turn | undefined,
	handle: string,
): FailureBanner | undefined {
	if (turn) return undefined;
	for (let index = entries.length - 1; index >= 0; index--) {
		let entry = entries[index]!;
		if (entry.turnFailure) {
			let view = failureView(entry.turnFailure);
			if (!view) return undefined;
			let asked = entry.turnFailure.request
				? entries.find(candidate => candidate.id === entry.turnFailure!.request)
				: undefined;
			let mine = !!asked && asked.author.kind === "member" && asked.author.handle === handle
				&& asked.to === "planner";
			return { ...view, retry: view.retry && mine, entry: entry.id };
		}
		if (entry.author.kind !== "system") return undefined;
	}
	return undefined;
}

/** The transcript without the failed reply's own line, which the banner tells instead. */
export function withoutFailure<T extends { id: string }>(
	entries: T[],
	entry: string | undefined,
): T[] {
	return entry === undefined ? entries : entries.filter(item => item.id !== entry);
}

/**
 * The turn asked for again, as it was: its text, its references, its destination and the document
 * that was open. Only a request id is new, so the server answers it as a message of its own.
 */
export function retryPayload(
	entries: readonly Chat.Entry[],
	failed: string,
	requestId: () => string,
): ChatSendPayload | undefined {
	let notice = entries.find(entry => entry.id === failed);
	let failure = notice?.turnFailure;
	let asked = failure?.request ? entries.find(entry => entry.id === failure.request) : undefined;
	if (!failure || !asked || asked.to !== "planner") return undefined;
	let references = (asked.references ?? []).map(referenceRequest);
	return {
		requestId: requestId(),
		text: asked.text,
		to: "planner",
		...(references.length > 0 ? { references } : {}),
		...(failure.focus ? { focus: failure.focus } : {}),
	};
}
