/**
 * Where an open child's title goes in the split workspace.
 *
 * Under Zoom the child replaces its parent in place, so its title, rename and actions join the
 * end of the parent's path in the parent's title bar. Under Lift the child's sheet carries a
 * title bar of its own. Either way the child room owns its title, so it renders it here.
 */

import { createContext } from "react";

import type { ChildMotionStyle } from "./child-motion";

export type ChildTitle = {
	motion: ChildMotionStyle;
	/** The end of the parent's path under Zoom; null until it mounts, and under Lift. */
	slot: HTMLElement | null;
};

export const ChildTitleContext = createContext<ChildTitle | undefined>(undefined);
