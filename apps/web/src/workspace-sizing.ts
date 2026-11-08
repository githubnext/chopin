import type { WorkspaceMode } from "./workspace-model";

export function workspaceSizing(available: number, preferred: number): {
	chat: number;
	maximum: number;
	mode: WorkspaceMode;
} {
	let mode: WorkspaceMode = available < 700 ? "compact" : "split";
	let maximum = Math.max(250, available - 450);
	return {
		chat: mode === "compact" ? available : Math.min(maximum, Math.max(250, preferred)),
		maximum,
		mode,
	};
}

/**
 * The width the workspace has to share between Chat and the document, readable without React.
 *
 * Dragging the Projects sidebar changes it on every frame. Held in state of the room, each of
 * those would render the room, its Chat and its editors; held here, only what reads it renders.
 */
export type WorkspaceSpace = {
	get: () => number;
	set: (width: number) => void;
	subscribe: (listener: () => void) => () => void;
};

export function createWorkspaceSpace(initial: number): WorkspaceSpace {
	let width = initial;
	let listeners = new Set<() => void>();
	return {
		get: () => width,
		set(next) {
			if (next === width) return;
			width = next;
			for (let listener of listeners) listener();
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => void listeners.delete(listener);
		},
	};
}
