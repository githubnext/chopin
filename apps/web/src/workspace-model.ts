import type { DecisionView } from "@chopin/editor";

export type WorkspaceMode = "compact" | "split";

export type WorkspaceSurface = "document" | "child";

export type WorkspacePresentation =
	| { type: "document" }
	| { childLabel: string; onChildClose: () => void; type: "parent-with-child" }
	| { label: string; onClose: () => void; type: "child" };

export type WorkspaceProfile = {
	implementation: boolean;
	persistChat: boolean;
	persistPaneSize: boolean;
	persistView: boolean;
	research: boolean;
	surface: WorkspaceSurface;
};

export type WorkspaceDestination = "plan" | "decisions" | "chat";

export type WorkspaceState = {
	chatOpen: boolean;
	desktopChatOpen: boolean;
};

export type WorkspaceEvent =
	| { type: "set-chat"; open: boolean }
	| { type: "set-desktop-chat"; open: boolean };

export const WORKSPACE_MEDIA = ["(max-width: 1023px)"] as const;

export function initialWorkspaceState(
	profile: WorkspaceProfile,
	desktopChatOpen: boolean,
): WorkspaceState {
	return {
		chatOpen: false,
		desktopChatOpen: profile.persistChat && desktopChatOpen,
	};
}

export function initialDocumentView(
	profile: WorkspaceProfile,
	stored: string | null,
): DecisionView {
	return profile.persistView ? storedDocumentView(stored) : "plan";
}

export function workspaceProfile(
	presentation: WorkspacePresentation,
): WorkspaceProfile {
	let child = presentation.type === "child";
	return {
		implementation: !child,
		persistChat: !child,
		persistPaneSize: !child,
		persistView: !child,
		research: !child,
		surface: child ? "child" : "document",
	};
}

export function workspaceDestinations(): WorkspaceDestination[] {
	return ["chat", "plan", "decisions"];
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
	if (event.type === "set-chat") return { ...state, chatOpen: event.open };
	return { ...state, desktopChatOpen: event.open };
}

export function presentWorkspace(
	state: WorkspaceState,
	mode: WorkspaceMode,
	documentView: DecisionView,
) {
	let chatVisible = mode === "split"
		? state.desktopChatOpen || state.chatOpen
		: state.chatOpen;
	let documentVisible = mode === "compact" ? !chatVisible : true;

	return {
		documentView,
		documentVisible,
		chatVisible,
		separatorVisible: mode === "split" && chatVisible,
	};
}
