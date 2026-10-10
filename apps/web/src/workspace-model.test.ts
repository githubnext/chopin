import { describe, expect, it } from "bun:test";

import {
	CHAT_CHOICE_STORAGE_KEY,
	initialDocumentView,
	initialWorkspaceState,
	presentWorkspace,
	storedDesktopChat,
	transitionWorkspace,
	workspaceDestinations,
	workspaceHeadingId,
	workspaceProfile,
} from "./workspace-model";

import type { WorkspaceState } from "./workspace-model";

const childPresentation = { label: "Source review", onClose() {}, type: "child" } as const;
const documentPresentation = { type: "document" } as const;

describe("adaptive workspace", () => {
	it("derives child capabilities from the workspace presentation", () => {
		expect(workspaceProfile(childPresentation))
			.toEqual({
				implementation: false,
				persistChat: false,
				persistPaneSize: false,
				persistView: false,
				research: false,
				surface: "child",
			});
	});

	it("starts every surface with the saved desktop Chat preference", () => {
		expect(initialWorkspaceState(true)).toEqual({
			chatOpen: false,
			desktopChatOpen: true,
		});
		expect(initialWorkspaceState(false)).toEqual({
			chatOpen: false,
			desktopChatOpen: false,
		});
	});

	it("starts a child on Document without inheriting the parent's saved view", () => {
		expect(initialDocumentView(workspaceProfile(childPresentation), "decisions")).toBe("plan");
		expect(initialDocumentView(workspaceProfile(childPresentation), "background-work"))
			.toBe("plan");
		expect(initialDocumentView(workspaceProfile(documentPresentation), "decisions"))
			.toBe("decisions");
		expect(initialDocumentView(workspaceProfile(documentPresentation), "background-work"))
			.toBe("plan");
		expect(initialDocumentView(workspaceProfile(documentPresentation), "tasks")).toBe("plan");
	});

	it("limits a child to Document, Decisions, and Chat", () => {
		let capabilities = workspaceProfile(childPresentation);

		expect(capabilities).toEqual({
			implementation: false,
			persistChat: false,
			persistPaneSize: false,
			persistView: false,
			research: false,
			surface: "child",
		});
		expect(workspaceDestinations(capabilities.implementation)).toEqual([
			"chat",
			"plan",
			"decisions",
		]);
	});

	it("keeps the parent's research and implementation capabilities", () => {
		expect(workspaceProfile(documentPresentation)).toEqual({
			implementation: true,
			persistChat: true,
			persistPaneSize: true,
			persistView: true,
			research: true,
			surface: "document",
		});
		expect(workspaceDestinations(true)).toEqual([
			"chat",
			"plan",
			"decisions",
			"build",
		]);
	});

	it("keeps child pane ids distinct from the mounted parent", () => {
		expect(workspaceHeadingId("plan")).toBe("workspace-plan-heading");
		expect(workspaceHeadingId("plan", "child-room")).toBe("child-room-workspace-plan-heading");
	});

	it("closing Chat leaves the visible document view untouched", () => {
		let state: WorkspaceState = {
			chatOpen: true,
			desktopChatOpen: false,
		};

		state = transitionWorkspace(state, { type: "set-chat", open: false });

		expect(state).toEqual({
			chatOpen: false,
			desktopChatOpen: false,
		});
		expect(presentWorkspace(state, "compact", "decisions")).toMatchObject({
			documentView: "decisions",
			documentVisible: true,
			chatVisible: false,
		});
	});

	it("keeps a desktop preference while compact Chat comes and goes", () => {
		let state: WorkspaceState = {
			chatOpen: false,
			desktopChatOpen: true,
		};

		state = transitionWorkspace(state, { type: "set-chat", open: true });
		expect(presentWorkspace(state, "compact", "plan")).toMatchObject({
			documentVisible: false,
			chatVisible: true,
		});
		state = transitionWorkspace(state, { type: "set-chat", open: false });
		expect(state.desktopChatOpen).toBe(true);
		expect(presentWorkspace(state, "split", "plan").chatVisible).toBe(true);
	});

	it("shows Chat as the only compact destination", () => {
		let state: WorkspaceState = {
			chatOpen: true,
			desktopChatOpen: true,
		};

		expect(presentWorkspace(state, "compact", "decisions")).toMatchObject({
			documentView: "decisions",
			documentVisible: false,
			chatVisible: true,
			separatorVisible: false,
		});
	});

	it("expands the document only when split Chat is hidden", () => {
		let hidden: WorkspaceState = { chatOpen: false, desktopChatOpen: false };
		let shown: WorkspaceState = { chatOpen: false, desktopChatOpen: true };
		let unset: WorkspaceState = { chatOpen: false, desktopChatOpen: undefined };

		expect(presentWorkspace(hidden, "split", "plan").documentExpanded).toBe(true);
		expect(presentWorkspace(shown, "split", "plan").documentExpanded).toBe(false);
		expect(presentWorkspace(unset, "split", "plan").documentExpanded).toBe(false);
		expect(presentWorkspace(hidden, "compact", "plan").documentExpanded).toBe(false);
		expect(presentWorkspace({ ...hidden, chatOpen: true }, "split", "plan").documentExpanded)
			.toBe(false);
	});
});

it("opens Chat by default and accepts only an explicit saved choice", () => {
	expect(CHAT_CHOICE_STORAGE_KEY).not.toBe("chopin:pane:chat:open");
	expect(storedDesktopChat(null)).toBeUndefined();
	expect(storedDesktopChat("true")).toBe(true);
	expect(storedDesktopChat("false")).toBe(false);
	expect(presentWorkspace(initialWorkspaceState(undefined), "split", "plan").chatVisible)
		.toBe(true);
	expect(presentWorkspace(initialWorkspaceState(false), "split", "plan").chatVisible).toBe(
		false,
	);
});
