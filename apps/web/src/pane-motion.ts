import { useEffect, useState } from "react";

import type { PresencePhase } from "@chopin/editor/transition-presence";
import type { RefObject, TransitionEvent as ReactTransitionEvent } from "react";

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
		onTransitionEnd: (event: ReactTransitionEvent<HTMLElement>) => {
			if (event.target !== event.currentTarget || event.propertyName !== "width") return;
			setState(current => ({ ...current, moving: false }));
		},
	};
}

/**
 * While a pane track animates, hold the document at its narrower width (the final one
 * when a pane opens, the current one when it closes) so prose re-wraps once instead of
 * on every frame; the column only re-centres while the space moves.
 */
export function usePaneSettledWidth(target: RefObject<HTMLElement | null>) {
	useEffect(() => {
		let track: EventTarget | undefined;
		let release = () => {
			track = undefined;
			target.current?.style.removeProperty("width");
			target.current?.style.removeProperty("align-self");
		};
		let run = (event: TransitionEvent) => {
			let element = target.current;
			let available = element?.parentElement?.clientWidth;
			if (
				!element || !available || event.propertyName !== "width"
				|| !(event.target instanceof HTMLElement)
				|| !event.target.matches(".motion-sidebar, .workspace-chat-panel")
			) {
				return;
			}
			let effect = event.target.getAnimations()
				.find(animation =>
					animation instanceof CSSTransition && animation.transitionProperty === "width"
				)
				?.effect;
			let frames = effect instanceof KeyframeEffect ? effect.getKeyframes() : undefined;
			let from = Number.parseFloat(String(frames?.[0]?.width));
			let to = Number.parseFloat(String(frames?.at(-1)?.width));
			if (!Number.isFinite(from) || !Number.isFinite(to)) return;
			track = event.target;
			// The narrower of the two widths never clips prose against the moving edge.
			element.style.width = `${Math.max(0, available - Math.max(0, to - from))}px`;
			element.style.alignSelf = "center";
		};
		let end = (event: TransitionEvent) => {
			if (event.target === track && event.propertyName === "width") release();
		};
		document.addEventListener("transitionrun", run);
		document.addEventListener("transitionend", end);
		document.addEventListener("transitioncancel", end);
		return () => {
			document.removeEventListener("transitionrun", run);
			document.removeEventListener("transitionend", end);
			document.removeEventListener("transitioncancel", end);
			release();
		};
	}, [target]);
}

/** The workspace waits for the sidebar track to settle before it re-measures its layout. */
export function sidebarMoving(): boolean {
	return document.getAnimations().some(animation =>
		animation instanceof CSSTransition && animation.transitionProperty === "width"
		&& animation.effect instanceof KeyframeEffect
		&& animation.effect.target instanceof Element
		&& animation.effect.target.matches(".motion-sidebar")
	);
}
