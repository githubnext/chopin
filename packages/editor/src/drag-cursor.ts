/**
 * Shows `cursor` over the whole page while a drag lasts, until the returned release: the handle's
 * own cursor would otherwise give way to the text cursor, a pointer or the arrow of whatever the
 * pointer crosses as it outruns the handle.
 *
 * It is one transparent layer over the window, carrying the cursor, rather than a rule that gives
 * every element the cursor: switching such a rule on restyles the whole page, which measured
 * hundreds of milliseconds on a long one at the moment the drag begins. The drag's pointer is
 * captured by its handle, so the layer takes no event from it. It must not outlive the drag, or it
 * would hide every control's cursor and swallow every click: release it however the drag ends.
 */
export function holdDragCursor(
	cursor: "col-resize" | "grabbing" | "nesw-resize" | "nwse-resize",
): () => void {
	let layer = document.createElement("div");
	layer.setAttribute("aria-hidden", "true");
	layer.setAttribute("data-drag-cursor", cursor);
	layer.style.cssText = "position:fixed;inset:0;z-index:2147483647";
	layer.style.cursor = cursor;
	document.body.append(layer);
	return () => layer.remove();
}
