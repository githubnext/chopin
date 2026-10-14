import type { ReactNode } from "react";
import type { DecisionView, ResearchOpener } from "@chopin/editor";

import type { ChildMotionStyle } from "./child-motion";

export type WorkspaceMode = "compact" | "split";

export type WorkspaceSurface = "document" | "child";

/** Opens a child by id and settles true once its document has synced. */
export type ChildOpen = (channelId: string) => Promise<boolean>;

export type WorkspacePresentation =
	| { onChildOpen?: ChildOpen; type: "document" }
	| {
		/** The host's layer, drawn in the root's document stack. */
		child: ReactNode;
		/** The child open in the stack; Chat sends it as the Planner's focus. */
		childId?: string;
		/** The host's request identity, stable through loading and canonical title changes. */
		childRequestKey: string;
		childState: "open" | "closing";
		motion: ChildMotionStyle;
		onChildClose: () => void;
		onChildOpen?: ChildOpen;
		/** Root first, open child last. */
		path: { id: string; label: string }[];
		type: "parent-with-child";
	}
	| { label: string; onClose: () => void; parent?: ChildParent; type: "child" };

/** The document a child opened from, and a way back to the place that produced it. */
export type ChildParent = {
	id: string;
	label: string;
	onReturn: (opener?: ResearchOpener) => void;
};

export type WorkspaceProfile = {
	/** Only a root document has a Chat. */
	chat: boolean;
	implementation: boolean;
	persistChat: boolean;
	persistPaneSize: boolean;
	persistView: boolean;
	research: boolean;
	surface: WorkspaceSurface;
};

export type WorkspaceDocumentView = DecisionView | "build";

export type WorkspaceDestination = WorkspaceDocumentView | "chat";

export type WorkspaceState = {
	chatOpen: boolean;
	/** Undefined until a person makes an explicit choice. */
	desktopChatOpen: boolean | undefined;
};

export type WorkspaceEvent =
	| { type: "set-chat"; open: boolean }
	| { type: "set-desktop-chat"; open: boolean };

export const CHAT_CHOICE_STORAGE_KEY = "chopin:pane:chat:choice";

export function storedDesktopChat(value: string | null): boolean | undefined {
	if (value === "true") return true;
	if (value === "false") return false;
}

export function initialWorkspaceState(
	desktopChatOpen: boolean | undefined,
): WorkspaceState {
	return {
		chatOpen: false,
		desktopChatOpen,
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
		chat: !child,
		implementation: !child,
		persistChat: !child,
		persistPaneSize: !child,
		persistView: !child,
		research: !child,
		surface: child ? "child" : "document",
	};
}

export function workspaceDestinations(implementation = false): WorkspaceDestination[] {
	return implementation ? ["chat", "plan", "decisions", "build"] : ["chat", "plan", "decisions"];
}

export function workspaceHeadingId(destination: WorkspaceDestination, scope?: string): string {
	return `${scope ? `${scope}-` : ""}workspace-${destination}-heading`;
}

export function storedDocumentView(value: string | null): DecisionView {
	if (value === "decisions") return value;
	return "plan";
}

export function transitionWorkspace(state: WorkspaceState, event: WorkspaceEvent): WorkspaceState {
	if (event.type === "set-chat") return { ...state, chatOpen: event.open };
	return { ...state, desktopChatOpen: event.open };
}

export function presentWorkspace(
	state: WorkspaceState,
	mode: WorkspaceMode,
	documentView: WorkspaceDocumentView,
) {
	let chatVisible = mode === "split"
		? (state.desktopChatOpen ?? true) || state.chatOpen
		: state.chatOpen;
	let documentVisible = mode === "compact" ? !chatVisible : true;

	return {
		documentView,
		documentVisible,
		documentExpanded: mode === "split" && !chatVisible,
		chatVisible,
		separatorVisible: mode === "split" && chatVisible,
	};
}
