import { currentViewport, listenToViewportChanges } from "@chopin/viewport";
import { useEffect } from "react";

export type ViewportVariables = {
	"--app-left": string;
	"--app-height": string;
	"--app-top": string;
	"--app-width": string;
	"--keyboard-inset": string;
};

export function viewportVars(
	layoutHeight: number,
	visual?: {
		height: number;
		offsetLeft?: number;
		offsetTop: number;
		scale?: number;
		width?: number;
	},
): ViewportVariables {
	// A pinch zoom shrinks and moves the visual viewport. Following it would lay the workspace out
	// again inside the zoomed region, so keep the layout viewport and let the browser zoom optically.
	let viewport = visual && Math.abs((visual.scale ?? 1) - 1) < 0.01 ? visual : undefined;
	let height = viewport?.height ?? layoutHeight;
	let covered = viewport ? layoutHeight - viewport.height - viewport.offsetTop : 0;
	return {
		"--app-left": `${Math.max(0, viewport?.offsetLeft ?? 0)}px`,
		"--app-height": `${Math.max(0, height)}px`,
		"--app-top": `${Math.max(0, viewport?.offsetTop ?? 0)}px`,
		"--app-width": viewport?.width === undefined ? "100%" : `${Math.max(0, viewport.width)}px`,
		"--keyboard-inset": `${Math.max(0, covered)}px`,
	};
}

/** Keeps the mounted workspace sized to the pixels the browser currently exposes. */
export function useVisualViewport(): void {
	useEffect(() => {
		let update = () => {
			let viewport = currentViewport();
			let variables = viewportVars(
				window.innerHeight,
				{
					height: viewport.height,
					offsetLeft: viewport.left,
					offsetTop: viewport.top,
					scale: window.visualViewport?.scale,
					width: viewport.width,
				},
			);
			for (let [name, value] of Object.entries(variables)) {
				document.documentElement.style.setProperty(name, value);
			}
		};

		update();
		return listenToViewportChanges(update);
	}, []);
}
