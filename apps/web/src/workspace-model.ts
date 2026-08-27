import type { DecisionView } from "@chopin/editor";

export type WorkspaceMode = "compact" | "split";

export type WorkspaceSurface = "document" | "child";

export type WorkspacePresentation =
	| { type: "document" }
	| { childLabel: string; onChildClose: () => void; type: "parent-with-child" }
	| { label: string; onClose: () => void; type: "child" };

export type WorkspaceProfile = {
	implementation: boolean;
	persistConversation: boolean;
	persistPaneSize: boolean;
	persistView: boolean;
	research: boolean;
	surface: WorkspaceSurface;
};

export type WorkspaceDestination = "plan" | "decisions" | "conversation";

export type WorkspaceState = {
	conversationOpen: boolean;
	desktopConversationOpen: boolean;
};

export type WorkspaceEvent =
	| { type: "set-conversation"; open: boolean }
	| { type: "set-desktop-conversation"; open: boolean };

export const WORKSPACE_MEDIA = ["(max-width: 1023px)"] as const;

export function initialWorkspaceState(
	profile: WorkspaceProfile,
	desktopConversationOpen: boolean,
): WorkspaceState {
	return {
		conversationOpen: false,
		desktopConversationOpen: profile.persistConversation && desktopConversationOpen,
	};
}

export function initialDocumentView(
	profile: WorkspaceProfile,
	stored: string | null,
): DecisionView {
	return profile.persistView ? storedDocumentView(stored) : "plan";
}

export function workspaceProfile(
	surface: WorkspaceSurface,
): WorkspaceProfile {
	let child = surface === "child";
	return {
		implementation: !child,
		persistConversation: !child,
		persistPaneSize: !child,
		persistView: !child,
		research: !child,
		surface,
	};
}

export function workspaceDestinations(): WorkspaceDestination[] {
	return ["conversation", "plan", "decisions"];
}

export function workspaceHeadingId(destination: WorkspaceDestination, scope?: string): string {
	return `${scope ? `${scope}-` : ""}workspace-${destination}-heading`;
}

export function storedDocumentView(value: string | null): DecisionView {
	if (value === "decisions") return value;
	return "plan";
}

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
	documentView: DecisionView,
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
