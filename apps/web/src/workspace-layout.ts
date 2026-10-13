import { useLayoutEffect, useRef, useState } from "react";
import { usePhone } from "@chopin/editor/pointer";

import { workspaceSizing } from "./workspace-sizing";

/** The workspace waits for the sidebar track to settle before it re-measures its layout. */
function sidebarMoving(): boolean {
	return document.getAnimations().some(animation =>
		animation instanceof CSSTransition && animation.transitionProperty === "width"
		&& animation.effect instanceof KeyframeEffect
		&& animation.effect.target instanceof Element
		&& animation.effect.target.matches(".motion-sidebar")
	);
}

/** Measures the workspace frame to choose split or compact, for the workspace and its skeleton. */
export function useWorkspaceLayout() {
	let frame = useRef<HTMLDivElement>(null);
	let [available, setAvailable] = useState(() => Math.max(0, window.innerWidth - 24));
	useLayoutEffect(() => {
		let element = frame.current;
		if (!element) return;
		let measure = () => {
			if (!sidebarMoving()) setAvailable(element.clientWidth);
		};
		measure();
		let observer = new ResizeObserver(measure);
		observer.observe(element);
		document.addEventListener("transitionend", measure);
		document.addEventListener("transitioncancel", measure);
		return () => {
			observer.disconnect();
			document.removeEventListener("transitionend", measure);
			document.removeEventListener("transitioncancel", measure);
		};
	}, []);
	// A phone keeps one destination at a time even when landscape gives it a wide window.
	let phone = usePhone();
	return {
		available,
		frame,
		mode: phone ? "compact" as const : workspaceSizing(available, 500).mode,
		phone,
	};
}
