export type WorkspaceMode = "compact" | "split";

export type WorkspaceDestination = "plan" | "decisions" | "conversation";

export type WorkspaceState = {
	conversationOpen: boolean;
	desktopConversationOpen: boolean;
};

export type WorkspaceEvent =
	| { type: "set-conversation"; open: boolean }
	| { type: "set-desktop-conversation"; open: boolean };

export const WORKSPACE_MEDIA = ["(max-width: 1023px)"] as const;

/** Classify the same media queries the subscription observes. */
export function workspaceMode(matchMedia: (query: string) => { matches: boolean }): WorkspaceMode {
	return matchMedia(WORKSPACE_MEDIA[0]).matches ? "compact" : "split";
}

export function transitionWorkspace(state: WorkspaceState, event: WorkspaceEvent): WorkspaceState {
	if (event.type === "set-conversation") return { ...state, conversationOpen: event.open };
	return { ...state, desktopConversationOpen: event.open };
}

export function presentWorkspace(
	state: WorkspaceState,
	mode: WorkspaceMode,
	documentView: "plan" | "decisions",
) {
	let conversationVisible = mode === "split"
		? state.desktopConversationOpen || state.conversationOpen
		: state.conversationOpen;
	let documentVisible = mode === "compact" ? !conversationVisible : true;

	return {
		documentView,
		documentVisible,
		conversationVisible,
		separatorVisible: mode === "split" && conversationVisible,
	};
}
