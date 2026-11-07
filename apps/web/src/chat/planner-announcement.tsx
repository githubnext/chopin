import { useEffect, useRef, useState } from "react";

import { plannerSpeech } from "./planner-status";
import type { PlannerStatus } from "./planner-status";

/**
 * The one place a screen reader hears of the Planner's state, whatever the page draws for it: a
 * polite, visually hidden status that says each problem state's machine-first sentence once as the
 * Planner enters it, and nothing while it is healthy. The button, its menu and the composer's
 * strip draw the same state without announcing it themselves, so it is never said twice, and it
 * does not depend on any of them being on the page. A status that is only withheld until the
 * machine is named (`withheld`) is a gap the state carries on through, not a clearing, so the same
 * state entered again after it is not said again. While the page's offline notice shows
 * (`offline`) the region is empty and says nothing new, since that notice is the one thing said
 * about the connection; what it last said is remembered, so it is not said again on return.
 */
export function PlannerAnnouncement(
	{ status, withheld, offline }: {
		status: PlannerStatus | undefined;
		withheld: boolean;
		offline: boolean;
	},
) {
	let previous = useRef<PlannerStatus["kind"] | undefined>(undefined);
	let [spoken, setSpoken] = useState("");
	useEffect(() => {
		let speech = plannerSpeech(previous.current, status, withheld, offline);
		if (!speech) return;
		setSpoken(speech.said);
		previous.current = speech.kind;
	}, [status, withheld, offline]);
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
