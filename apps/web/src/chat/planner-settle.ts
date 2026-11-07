import { CONNECTION_GRACE } from "@chopin/editor";
import { useEffect, useRef, useState } from "react";

import type { Session } from "@chopin/protocol";
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
 * Whether `status` takes the place of `shown` now. A state that waits does not, unless it is more
 * of the one already shown, such as the machine's name arriving: the last state stays until the
 * new one has lasted its grace. A placeholder (`held`) never does: the last state stays until the
 * machine's own word comes.
 */
export function plannerShownAtOnce(
	shown: PlannerStatus | undefined,
	status: PlannerStatus | undefined,
	held = false,
): boolean {
	return !held && (plannerGrace(status) === 0 || shown?.kind === status?.kind);
}

/**
 * What is drawn: nothing while `withheld` (the machine is not known yet, so the status says
 * nothing), else the new state if it shows at once, else the last one shown.
 */
export function plannerDrawn(
	shown: PlannerStatus | undefined,
	status: PlannerStatus | undefined,
	held = false,
	withheld = false,
): PlannerStatus | undefined {
	return withheld ? undefined : plannerShownAtOnce(shown, status, held) ? status : shown;
}

/**
 * The status to say: the last known one, until a state that waits has lasted its grace. While
 * `withheld` it says nothing, but what it had shown is remembered, so the same state returning once
 * the machine is named is not made to wait out its grace again: a gap in what is said is not the
 * state ending.
 */
export function useSettledPlannerStatus(
	status: PlannerStatus | undefined,
	held?: boolean,
	withheld?: boolean,
): PlannerStatus | undefined {
	let [shown, setShown] = useState<PlannerStatus | undefined>(() =>
		plannerGrace(status) === 0 ? status : undefined
	);
	let atOnce = plannerShownAtOnce(shown, status, held);
	let latest = useRef(status);
	latest.current = status;
	useEffect(() => {
		if (atOnce && !withheld && shown !== status) setShown(status);
	});
	useEffect(() => {
		if (atOnce || held || withheld) return;
		let timer = setTimeout(() => setShown(latest.current), plannerGrace(status));
		return () => clearTimeout(timer);
	}, [atOnce, held, withheld, status?.kind]);
	return plannerDrawn(shown, status, held, withheld);
}
