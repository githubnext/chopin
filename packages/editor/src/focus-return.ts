/**
 * Whether a popup may give focus back to whatever opened it as it leaves: focus is still in it, or
 * nowhere. Base UI keeps a popup from taking focus from a control the person moved to while it
 * closed, but only when `finalFocus` is left a boolean; a function, or focus given back by hand once
 * a sheet has left, decides alone, so the guard is the caller's. Without it, a tap into the document
 * while a phone sheet fell away (260ms) lost its caret to the sheet's opener, and a machine button
 * pressed while the Machines menu faded (120ms) had its menu shut again.
 */
export function focusIsFree(...within: (Element | null | undefined)[]): boolean {
	let active = document.activeElement;
	return !active || active === document.body || within.some(element => element?.contains(active));
}
