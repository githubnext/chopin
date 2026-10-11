/**
 * A child document on a phone borrows its parent's tab bar.
 *
 * The child opens over the parent's Document tab, so the bar's trailing control edits the
 * child, not the parent hidden beneath it, and the child's formatting docks where the parent's
 * would. The parent owns the bar; the child reports how it is held and how to toggle it.
 */

import { createContext } from "react";

/** How an open child is held, for the parent's bar to show. */
export type ChildEditState = { docked: boolean; editing: boolean };

export type ChildPhoneChrome = {
	/** Host for the docked formatting toolbar, present while the child reports it docked. */
	formatDock: HTMLElement | null;
	/** Undefined while the child has no reading mode, such as for a viewer. */
	report: (state: ChildEditState | undefined, toggle?: () => void) => void;
	/** Bring the parent's Document tab, which holds the child, forward. */
	showDocument: () => void;
	/** Whether the child is on screen: the Document tab is showing. */
	visible: boolean;
};

export const ChildPhoneChromeContext = createContext<ChildPhoneChrome | undefined>(undefined);

export function sameEditState(a?: ChildEditState, b?: ChildEditState): boolean {
	return a?.docked === b?.docked && a?.editing === b?.editing;
}
