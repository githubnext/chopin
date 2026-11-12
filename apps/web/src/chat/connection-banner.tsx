import { useEffect, useMemo, useRef, useState } from "react";

import { OFFLINE_BAR_GRACE, useConnectionNotice } from "@chopin/editor";
import { useTransitionPresence } from "@chopin/editor/transition-presence";

import {
	connectionSpeech,
	connectionStep,
	expireResumed,
	INITIAL_MEMORY,
	NOTHING_SPOKEN,
	offlineBar,
	RESUMED_MS,
} from "./connection-phase";
import { useConnectionSpeaking } from "../connection-speaking";
import { ConnectionState } from "./connection-state";
import type {
	ConnectionFacts,
	ConnectionMemory,
	ConnectionView,
	OfflineBar,
	Spoken,
} from "./connection-phase";
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
	/** Reconnects the room's socket, or nothing where the offline bar has no button. */
	onRetry: (() => void) | undefined;
};

/**
 * The page's connection state for a document: the phase machine (`connection-phase.ts`) fed by the
 * room's socket, the document and transcript catching up on it, and the Planner's connection, with
 * the timing it needs (the ten seconds a loss stays silent for, as Slack's does, how long the return
 * is remembered, which attempt a person's Reconnect started). Only the offline bar is ever drawn
 * from it; every phase is spoken once. Held above wherever the bar is drawn, so a person moving
 * between Chat and the document during one outage neither waits out the grace again nor hears of
 * it twice.
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
		plannerMove,
		lostEdits,
		reconnect,
	}: {
		/** The room's connection is lost: it reports an outage (`isOffline`). */
		lost: boolean;
		failures: number;
		synced: boolean;
		unsaved: boolean;
		transcript: TranscriptFacts;
		/** The Planner's status where the page speaks of it (`plannerForBanner`). */
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
		/** How many times the person moved it to another machine (`ConnectionFacts.plannerMove`). */
		plannerMove?: number;
		reconnect: () => void;
	},
): ConnectionBanner {
	let shown = useConnectionNotice(lost, false, OFFLINE_BAR_GRACE) !== "none";
	// Where the failures stood when Reconnect was pressed, until that attempt fails or ends.
	let [pressed, setPressed] = useState<number>();
	useEffect(() => {
		if (pressed !== undefined && (!lost || failures > pressed)) setPressed(undefined);
	}, [lost, failures, pressed]);
	let [memory, setMemory] = useState<ConnectionMemory>(INITIAL_MEMORY);
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
		...(plannerMove ? { plannerMove } : {}),
	};
	let step = connectionStep(memory, facts);
	useEffect(() => {
		if (step.memory !== memory) setMemory(step.memory);
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
		"plannerMove" in step.view ? step.view.plannerMove : undefined,
		plannerHeld,
	]);

	let view = step.view;
	let onRetry = view.phase === "dropped" && view.action === "reconnect"
		? () => {
			setPressed(failures);
			reconnect();
		}
		: undefined;
	let offline = (view.phase === "reconnecting" || view.phase === "dropped")
		&& view.layer !== "planner";
	// The page-top navigation error must not tell this loss a second time.
	useConnectionSpeaking(offline);
	return { view, offline, spoken, onRetry };
}

/** How long the offline bar takes to fade once the connection is back. */
const BAR_EXIT_MS = 120;

/**
 * The offline bar for a view: nothing while online, catching up or just back, and for the
 * Planner's machine, which is presence on the machine button and on chopin. It fades out when the
 * connection returns, and says nothing as it goes.
 */
export function ConnectionBannerView(
	{ view, onRetry, id }: { view: ConnectionView; onRetry: (() => void) | undefined; id?: string },
) {
	let next = offlineBar(view);
	// One value for as long as the bar says the same, so its presence is not restarted each render.
	let bar = useMemo(() => next, [next?.phase, next?.text, next?.action]);
	let presence = useTransitionPresence<OfflineBar>(bar, BAR_EXIT_MS, false);
	if (presence.phase === "closed") return null;
	let shown = presence.value;
	return (
		<ConnectionState
			id={id}
			message={shown.text}
			onRetry={bar && shown.action === "reconnect" ? onRetry : undefined}
			phase={shown.phase}
			closing={presence.phase === "closing"}
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
