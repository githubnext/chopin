import { CONNECTION_GRACE } from "@chopin/editor";
import { useEffect, useRef, useState } from "react";

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
 * Whether `status` takes the place of `shown` now. A state that waits does not, unless it is more
 * of the one already shown, such as the machine's name arriving: the last state stays until the
 * new one has lasted its grace.
 */
export function plannerShownAtOnce(
	shown: PlannerStatus | undefined,
	status: PlannerStatus | undefined,
): boolean {
	return plannerGrace(status) === 0 || shown?.kind === status?.kind;
}

/** The status to say: the last known one, until a state that waits has lasted its grace. */
export function useSettledPlannerStatus(
	status: PlannerStatus | undefined,
): PlannerStatus | undefined {
	let [shown, setShown] = useState<PlannerStatus | undefined>(() =>
		plannerGrace(status) === 0 ? status : undefined
	);
	let atOnce = plannerShownAtOnce(shown, status);
	let latest = useRef(status);
	latest.current = status;
	useEffect(() => {
		if (atOnce && shown !== status) setShown(status);
	});
	useEffect(() => {
		if (atOnce) return;
		let timer = setTimeout(() => setShown(latest.current), plannerGrace(status));
		return () => clearTimeout(timer);
	}, [atOnce, status?.kind]);
	return atOnce ? status : shown;
}
