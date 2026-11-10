import { useEffect, useRef, useState } from "react";

import { useConnectionNotice } from "@chopin/editor";

import {
	connectionSpeech,
	connectionStep,
	expireResumed,
	INITIAL_MEMORY,
	NOTHING_SPOKEN,
	RESUMED_MS,
} from "./connection-phase";
import { useConnectionSpeaking } from "../connection-speaking";
import { ConnectionState } from "./connection-state";
import type { ConnectionFacts, ConnectionMemory, ConnectionView, Spoken } from "./connection-phase";
import type { PlannerStatus } from "./planner-status";

/** What the transcript, which Chat owns, tells the banner. */
export type TranscriptFacts = { turn: string | undefined; messages: number; current: boolean };

export const NO_TRANSCRIPT: TranscriptFacts = { turn: undefined, messages: 0, current: true };

export type ConnectionBanner = {
	view: ConnectionView;
	/** The room's connection is the cause: the page is cut off, or is catching up on a return. */
	offline: boolean;
	/** The one thing a screen reader is told as the phase changes. */
	spoken: string;
	/** Retries the layer the banner speaks of, or nothing where the banner has no button. */
	onRetry: (() => void) | undefined;
};

/**
 * The one connection banner's state for a document: the phase machine (`connection-phase.ts`)
 * fed by the room's socket, the document and transcript catching up on it, and the Planner's
 * connection, with the timing it needs (the grace a loss stays silent for, how long the return is
 * said, which attempt a person's Reconnect started). Held above wherever the banner is drawn, so a
 * person moving between Chat and the document during one outage neither waits out the grace again
 * nor hears of it twice.
 */
export function useConnectionBanner(
	{
		lost,
		failures,
		synced,
		unsaved,
		transcript,
		planner,
		plannerAttached,
		plannerHeld,
		lostEdits,
		reconnect,
		wake,
		chooseMachine,
	}: {
		/** The room's connection is lost: it reports an outage (`isOffline`). */
		lost: boolean;
		failures: number;
		synced: boolean;
		unsaved: boolean;
		transcript: TranscriptFacts;
		/** The Planner's status where the banner tells it (`plannerForBanner`). */
		planner: PlannerStatus | undefined;
		/**
		 * The room's own word, on the current socket, is that the Planner is attached. Not the same
		 * as `planner` being undefined, which is also a status withheld or hidden.
		 */
		plannerAttached: boolean;
		/** How many replacements of the document dropped edits the server never acknowledged. */
		lostEdits: number;
		/** The Planner's status is only withheld for a moment, not over. */
		plannerHeld: boolean;
		reconnect: () => void;
		/** Asks the machine to try now, where something can; without it no such button is drawn. */
		wake?: () => void;
		/**
		 * Opens the machine choice, for a viewer who may choose; without it a Planner that is away
		 * is told with no button, since Chopin cannot reconnect another's machine.
		 */
		chooseMachine?: () => void;
	},
): ConnectionBanner {
	let shown = useConnectionNotice(lost) !== "none";
	// Where the failures stood when Reconnect was pressed, until that attempt fails or ends.
	let [pressed, setPressed] = useState<number>();
	useEffect(() => {
		if (pressed !== undefined && (!lost || failures > pressed)) setPressed(undefined);
	}, [lost, failures, pressed]);
	let [memory, setMemory] = useState<ConnectionMemory>(INITIAL_MEMORY);
	// `failures` starts over when the socket opens, so the attempt that opened it is the last one
	// counted while the loss was shown. Left unknown, never guessed, where none was.
	let attempt = useRef<number>(undefined);
	let facts: ConnectionFacts = {
		socket: shown ? "lost" : "up",
		failures,
		retrying: pressed,
		synced,
		unsaved,
		current: transcript.current,
		turn: transcript.turn,
		messages: transcript.messages,
		planner,
		lostEdits,
		plannerAttached,
		reopened: attempt.current,
		chooseMachine: chooseMachine !== undefined,
	};
	let step = connectionStep(memory, facts);
	useEffect(() => {
		if (step.memory !== memory) setMemory(step.memory);
		if (lost && shown) attempt.current = failures + 1;
		else if (!step.memory.lost) attempt.current = undefined;
	});
	let resumed = step.view.phase === "resumed";
	useEffect(() => {
		if (!resumed) return;
		let timer = setTimeout(() => setMemory(expireResumed), RESUMED_MS);
		return () => clearTimeout(timer);
	}, [resumed]);

	let last = useRef<Spoken>(NOTHING_SPOKEN);
	let [spoken, setSpoken] = useState("");
	useEffect(() => {
		let speech = connectionSpeech(last.current, step.view, plannerHeld);
		if (!speech) return;
		last.current = speech.spoken;
		setSpoken(speech.said);
	}, [
		step.view.phase,
		"layer" in step.view ? step.view.layer : undefined,
		"plannerKind" in step.view ? step.view.plannerKind : undefined,
		plannerHeld,
	]);

	let view = step.view;
	let onRetry = view.phase === "dropped" && view.action === "reconnect"
		? () => {
			setPressed(failures);
			reconnect();
		}
		: view.phase === "dropped" && view.action === "wake"
		? wake
		: view.phase === "dropped" && view.action === "choose"
		? chooseMachine
		: undefined;
	let offline = (view.phase === "reconnecting" || view.phase === "dropped")
		&& view.layer !== "planner";
	// The page-top navigation error must not tell this loss a second time.
	useConnectionSpeaking(offline);
	return { view, offline, spoken, onRetry };
}

/** The banner for a view: nothing while online. */
export function ConnectionBannerView(
	{ view, onRetry, id }: { view: ConnectionView; onRetry: (() => void) | undefined; id?: string },
) {
	if (view.phase === "online") return null;
	return (
		<ConnectionState
			attempt={view.phase === "reconnecting" ? view.attempt : undefined}
			caught={view.phase === "resumed" ? view.caught : undefined}
			detail={view.phase === "resumed" ? undefined : view.detail}
			id={id}
			layer={"layer" in view ? view.layer : undefined}
			link={view.phase === "resumed" ? undefined : view.link}
			message={view.text}
			onRetry={onRetry}
			phase={view.phase}
			retryLabel={view.phase === "dropped" && view.action === "wake"
				? "Try again"
				: view.phase === "dropped" && view.action === "choose"
				? "Choose machine"
				: undefined}
		/>
	);
}

/** What a screen reader is told as the phase changes: one polite word per change, in one place. */
export function ConnectionAnnouncement({ spoken }: { spoken: string }) {
	return (
		<span
			aria-atomic="true"
			aria-live="polite"
			className="sr-only"
			data-connection-status=""
			role="status"
		>
			{spoken}
		</span>
	);
}
