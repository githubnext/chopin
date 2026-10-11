import { CHILD_MOTION_STORAGE_KEY, childMotionStyle } from "./child-motion";

let toggleEnabled = import.meta.env.DEV || import.meta.env.VITE_CHILD_MOTION_TOGGLE === "on";

export function readChildMotionStyle() {
	let stored: string | null = null;
	try {
		stored = localStorage.getItem(CHILD_MOTION_STORAGE_KEY);
	} catch {
		// Storage can be unavailable; Lift is the default.
	}
	return childMotionStyle(toggleEnabled, stored);
}
