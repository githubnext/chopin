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
