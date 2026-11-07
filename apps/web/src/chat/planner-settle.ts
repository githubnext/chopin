import { CONNECTION_GRACE } from "@chopin/editor";
import { useEffect, useRef, useState } from "react";

import type { Session } from "@chopin/protocol";
import { plannerSentence } from "./planner-status";
import type { PlannerStatus } from "./planner-status";

/**
 * How long a state waits before it is said. A machine being connected to, and none yet, are what a
 * restart or a deploy passes through on its way back, so they are said only once they have lasted
 * as long as a lost connection does before the page speaks of it. Anything a person can act on, and
 * every state clearing, is said at once.
 */
export function plannerGrace(status: PlannerStatus | undefined): number {
	return status?.kind === "starting" || status?.kind === "none" ? CONNECTION_GRACE : 0;
}

/**
 * What the page knows of the Planner across its connection's losses. A server that has just started
 * tells `none` to everyone who connects until a machine returns, however long that takes: not news
 * of the machine, but the new server's placeholder. It is one only for a page that knew a state
 * before the loss (`known`) and is still waiting for the new server's first word that is not
 * `none` (`returning`). A page that knew nothing, or only `none`, takes the word as its own
 * (`unknown`), and so does one that is told `none` after any other word: a machine removed while
 * the page is connected is still said.
 */
export type PlannerView = "unknown" | "known" | "returning";

/** The connection was lost. */
export function plannerConnectionLost(view: PlannerView): PlannerView {
	return view === "known" ? "returning" : view;
}

/** `word` was told: `returning` afterwards says it was a placeholder. */
export function plannerWordHeard(view: PlannerView, word: Session.PlannerAttachment): PlannerView {
	return word.state !== "none" ? "known" : view === "returning" ? view : "unknown";
}

/**
 * What the status remembers: `shown`, the last state it drew, and whether a gap, in which nothing
 * was drawn because the machine was not known yet, has passed since. Through a gap `shown` is kept
 * only so the same state returning is not made to wait out its grace again; it is never drawn in
 * place of a different one.
 */
export type PlannerMemory = { shown: PlannerStatus | undefined; gapped: boolean };

function samePlannerState(shown: PlannerStatus, status: PlannerStatus): boolean {
	return shown.kind === status.kind && plannerSentence(shown) === plannerSentence(status);
}

/**
 * Whether `status` takes the place of `shown` now. A state that waits does not, unless it is more
 * of the one already shown, such as the machine's name arriving: the last state stays until the
 * new one has lasted its grace. After a gap (`gapped`) what was shown is not the last state any
 * more, only a state that may be returning, so it skips the grace only if it is that same state.
 * A placeholder (`held`) never does: the last state stays until the machine's own word comes.
 */
export function plannerShownAtOnce(
	shown: PlannerStatus | undefined,
	status: PlannerStatus | undefined,
	held = false,
	gapped = false,
): boolean {
	if (held) return false;
	if (plannerGrace(status) === 0) return true;
	return gapped
		? !!shown && !!status && samePlannerState(shown, status)
		: shown?.kind === status?.kind;
}

/**
 * What is drawn: nothing while `withheld` (the machine is not known yet, so the status says
 * nothing), else the new state if it shows at once, else the last one shown, unless a gap has
 * passed since (`gapped`), when a state that waits draws nothing until it has lasted its grace.
 */
export function plannerDrawn(
	shown: PlannerStatus | undefined,
	status: PlannerStatus | undefined,
	held = false,
	withheld = false,
	gapped = false,
): PlannerStatus | undefined {
	if (withheld) return undefined;
	if (plannerShownAtOnce(shown, status, held, gapped)) return status;
	return gapped ? undefined : shown;
}

/**
 * What is remembered once `status` has been drawn: a gap marks what was shown as one that may
 * return, and a state drawn, at once or once its grace has `lapsed`, replaces it and ends the gap.
 */
export function plannerRemembered(
	memory: PlannerMemory,
	status: PlannerStatus | undefined,
	held: boolean,
	withheld: boolean,
	lapsed = false,
): PlannerMemory {
	if (withheld) {
		return memory.gapped || !memory.shown
			? memory
			: { shown: memory.shown, gapped: true };
	}
	if (held || !(lapsed || plannerShownAtOnce(memory.shown, status, held, memory.gapped))) {
		return memory;
	}
	return memory.shown === status && !memory.gapped ? memory : { shown: status, gapped: false };
}

/**
 * The status to say: the last known one, until a state that waits has lasted its grace. While
 * `withheld` it says nothing, but what it had shown is remembered, so the same state returning once
 * the machine is named is not made to wait out its grace again: a gap in what is said is not the
 * state ending. Any other state that arrives after the gap is said by its own rules, never in
 * place of what was shown before it.
 */
export function useSettledPlannerStatus(
	status: PlannerStatus | undefined,
	held?: boolean,
	withheld?: boolean,
): PlannerStatus | undefined {
	let [memory, setMemory] = useState<PlannerMemory>(() => ({
		shown: plannerGrace(status) === 0 ? status : undefined,
		gapped: false,
	}));
	let atOnce = plannerShownAtOnce(memory.shown, status, held, memory.gapped);
	let latest = useRef(status);
	latest.current = status;
	useEffect(() => {
		let next = plannerRemembered(memory, status, !!held, !!withheld);
		if (next !== memory) setMemory(next);
	});
	useEffect(() => {
		if (atOnce || held || withheld) return;
		let timer = setTimeout(
			() => setMemory(current => plannerRemembered(current, latest.current, false, false, true)),
			plannerGrace(status),
		);
		return () => clearTimeout(timer);
	}, [atOnce, held, withheld, status?.kind]);
	return plannerDrawn(memory.shown, status, held, withheld, memory.gapped);
}
