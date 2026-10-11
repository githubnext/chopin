import type { ViewportBox } from "./placement";

/** A phone's docked formatting covers the bottom of the document; keep a surface above it. */
export function aboveDock(viewport: ViewportBox): ViewportBox {
	let dock = document.querySelector(".plan-format-dock")?.getBoundingClientRect();
	if (!dock || dock.height === 0 || dock.top >= viewport.top + viewport.height) return viewport;
	return { ...viewport, height: Math.max(0, dock.top - viewport.top) };
}
