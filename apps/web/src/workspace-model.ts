import type { DecisionView } from "@chopin/editor";

export type WorkspaceMode = "compact" | "split";

export type WorkspaceSurface = "document" | "child";

export type WorkspaceDestination = "plan" | "decisions" | "background-work" | "conversation";

export type WorkspaceState = {
	conversationOpen: boolean;
	desktopConversationOpen: boolean;
};

export type WorkspaceEvent =
	| { type: "set-conversation"; open: boolean }
	| { type: "set-desktop-conversation"; open: boolean };

export const WORKSPACE_MEDIA = ["(max-width: 1023px)"] as const;

export function initialWorkspaceState(
	surface: WorkspaceSurface,
	desktopConversationOpen: boolean,
): WorkspaceState {
	return {
		conversationOpen: false,
		desktopConversationOpen: surface === "document" && desktopConversationOpen,
	};
}

export function initialDocumentView(
	surface: WorkspaceSurface,
	stored: string | null,
): DecisionView {
	return surface === "child" ? "plan" : storedDocumentView(stored);
}

export function workspaceCapabilities(surface: WorkspaceSurface, backgroundJobs: boolean) {
	let child = surface === "child";
	return {
		backgroundJobs: !child && backgroundJobs,
		implementation: !child,
		research: !child,
	};
}

export function workspaceDestinations(backgroundWork: boolean): WorkspaceDestination[] {
	return backgroundWork
		? ["conversation", "plan", "decisions", "background-work"]
		: ["conversation", "plan", "decisions"];
}

export function workspaceHeadingId(destination: WorkspaceDestination, scope?: string): string {
	return `workspace-${scope ? `${scope}-` : ""}${destination}-heading`;
}

export function storedDocumentView(value: string | null): DecisionView {
	if (value === "decisions" || value === "background-work") return value;
	if (value === "tasks") return "background-work";
	return "plan";
}

export function availableDocumentView(view: DecisionView, backgroundJobs: boolean): DecisionView {
	return view === "background-work" && !backgroundJobs ? "plan" : view;
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
	documentView: "plan" | "decisions" | "background-work",
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
