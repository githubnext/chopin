import { useEffect, useRef, useState } from "react";

import { plannerAnnouncement } from "./planner-status";
import type { PlannerStatus } from "./planner-status";

/**
 * The one place a screen reader hears of the Planner's state, whatever the page draws for it: a
 * polite, visually hidden status that says each problem state's machine-first sentence once as the
 * Planner enters it, and nothing while it is healthy. The button, its menu and the composer's
 * strip draw the same state without announcing it themselves, so it is never said twice, and it
 * does not depend on any of them being on the page.
 */
export function PlannerAnnouncement({ status }: { status: PlannerStatus | undefined }) {
	let previous = useRef<PlannerStatus["kind"] | undefined>(undefined);
	let [spoken, setSpoken] = useState("");
	useEffect(() => {
		if (status?.kind === previous.current) return;
		setSpoken(plannerAnnouncement(previous.current, status));
		previous.current = status?.kind;
	}, [status]);
	return (
		<span
			aria-atomic="true"
			aria-live="polite"
			className="sr-only"
			data-planner-status=""
			role="status"
		>
			{spoken}
		</span>
	);
}
