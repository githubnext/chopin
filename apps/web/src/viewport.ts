import { currentViewport, listenToViewportChanges } from "@chopin/viewport";
import { useEffect } from "react";

/**
 * The page's height and the keyboard's inset, which elements across the page read, as custom
 * properties of the page; and `#root`'s own `left`, `top` and `width`, which only it follows. As
 * custom properties of the page those three were inherited by every element, so each step of a window
 * resize changed one and restyled the whole page.
 */
export type ViewportVariables = {
	"--app-height": string;
	"--keyboard-inset": string;
	left: string;
	top: string;
	width: string;
};

export function viewportVars(
	layoutHeight: number,
	visual?: {
		height: number;
		left?: number;
		top: number;
		width?: number;
	},
	scale = 1,
): ViewportVariables {
	// A pinch zoom shrinks and moves the visual viewport. Following it would lay the workspace out
	// again inside the zoomed region, so keep the layout viewport and let the browser zoom optically.
	let viewport = visual && Math.abs(scale - 1) < 0.01 ? visual : undefined;
	let height = viewport?.height ?? layoutHeight;
	let covered = viewport ? layoutHeight - viewport.height - viewport.top : 0;
	return {
		"--app-height": `${Math.max(0, height)}px`,
		"--keyboard-inset": `${Math.max(0, covered)}px`,
		left: `${Math.max(0, viewport?.left ?? 0)}px`,
		top: `${Math.max(0, viewport?.top ?? 0)}px`,
		width: viewport?.width === undefined ? "100%" : `${Math.max(0, viewport.width)}px`,
	};
}

/** Taller than any browser toolbar, shorter than any software keyboard. */
export const KEYBOARD_OPEN_MIN = 120;

export function keyboardOpen(variables: ViewportVariables): boolean {
	return parseFloat(variables["--keyboard-inset"]) >= KEYBOARD_OPEN_MIN;
}

/** Keeps the mounted workspace, `root`, sized to the pixels the browser currently exposes. */
export function useVisualViewport(root: HTMLElement): void {
	useEffect(() => {
		let update = () => {
			let variables = viewportVars(
				window.innerHeight,
				currentViewport(),
				window.visualViewport?.scale,
			);
			// A value written again unchanged invalidates nothing.
			for (let [name, value] of Object.entries(variables)) {
				(name[0] === "-" ? document.documentElement : root).style.setProperty(name, value);
			}
			document.documentElement.toggleAttribute("data-keyboard-open", keyboardOpen(variables));
		};

		update();
		return listenToViewportChanges(update);
	}, [root]);
}
