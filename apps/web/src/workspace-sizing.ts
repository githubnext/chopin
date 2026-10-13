import type { WorkspaceMode } from "./workspace-model";

export const CHAT_PANE = {
	initial: 500,
	max: Number.MAX_SAFE_INTEGER,
	min: 250,
	storageKey: "chopin:pane:chat",
};

export const CHAT_CHOICE_STORAGE_KEY = "chopin:pane:chat:choice";

export function storedDesktopChat(value: string | null): boolean | undefined {
	if (value === "true") return true;
	if (value === "false") return false;
}

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
