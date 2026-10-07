import { useState } from "react";

import type { PresencePhase } from "@chopin/editor/transition-presence";
import type { TransitionEvent } from "react";

/** Whether a pane track should animate its width after a presence phase change. */
export function paneMoving(previous: PresencePhase, next: PresencePhase, moving: boolean): boolean {
	if (next === "closed") return false;
	if (next === "open") {
		return previous === "closed"
			? false
			: previous === "opening"
			? moving
			: true;
	}
	return true;
}

/**
 * A pane track animates its width only while it opens or closes, so dragging its
 * resize handle or a neighbouring resize still follows the pointer immediately.
 */
export function usePaneMotion(phase: PresencePhase) {
	let [state, setState] = useState({ moving: false, phase });
	if (state.phase !== phase) {
		state = { moving: paneMoving(state.phase, phase, state.moving), phase };
		setState(state);
	}
	return {
		moving: state.moving,
		onTransitionEnd: (event: TransitionEvent<HTMLElement>) => {
			if (event.target !== event.currentTarget || event.propertyName !== "width") return;
			setState(current => ({ ...current, moving: false }));
		},
	};
}
