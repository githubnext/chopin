import { describe, expect, it } from "bun:test";

import {
	initialDocumentView,
	initialWorkspaceState,
	presentWorkspace,
	transitionWorkspace,
	workspaceDestinations,
	workspaceHeadingId,
	workspaceMode,
	workspaceProfile,
} from "./workspace-model";

import type { WorkspaceState } from "./workspace-model";

type MatchMedia = (query: string) => { matches: boolean };

function mediaAt(width: number): MatchMedia {
	return query => {
		let maximum = /\(max-width: (\d+)px\)/.exec(query);
		return { matches: maximum !== null && width <= Number(maximum[1]) };
	};
}

describe("adaptive workspace", () => {
	it("starts a child with Conversation collapsed without inheriting the desktop preference", () => {
		expect(initialWorkspaceState(workspaceProfile("child", true), true)).toEqual({
			conversationOpen: false,
			desktopConversationOpen: false,
		});
	});

	it("starts a child on Document without inheriting the parent's saved view", () => {
		expect(initialDocumentView(workspaceProfile("child", true), "decisions")).toBe("plan");
		expect(initialDocumentView(workspaceProfile("child", true), "background-work")).toBe("plan");
		expect(initialDocumentView(workspaceProfile("document", true), "decisions"))
			.toBe("decisions");
	});

	it("limits a child to Document, Decisions, and Conversation", () => {
		let capabilities = workspaceProfile("child", true);

		expect(capabilities).toEqual({
			backgroundJobs: false,
			implementation: false,
			persistConversation: false,
			persistPaneSize: false,
			persistView: false,
			research: false,
			surface: "child",
		});
		expect(workspaceDestinations(capabilities.backgroundJobs)).toEqual([
			"conversation",
			"plan",
			"decisions",
		]);
	});

	it("keeps the parent's legacy implementation surface without background jobs", () => {
		expect(workspaceProfile("document", false)).toEqual({
			backgroundJobs: false,
			implementation: true,
			persistConversation: true,
			persistPaneSize: true,
			persistView: true,
			research: true,
			surface: "document",
		});
	});

	it("keeps child pane ids distinct from the mounted parent", () => {
		expect(workspaceHeadingId("plan")).toBe("workspace-plan-heading");
		expect(workspaceHeadingId("plan", "child-room")).toBe("child-room-workspace-plan-heading");
	});

	it("classifies the media queries production reads at each boundary", () => {
		expect([1023, 1024].map(width => workspaceMode(mediaAt(width)))).toEqual([
			"compact",
			"split",
		]);
	});

	it("closing Conversation leaves the visible document view untouched", () => {
		let state: WorkspaceState = {
			conversationOpen: true,
			desktopConversationOpen: false,
		};

		state = transitionWorkspace(state, { type: "set-conversation", open: false });

		expect(state).toEqual({
			conversationOpen: false,
			desktopConversationOpen: false,
		});
		expect(presentWorkspace(state, "compact", "decisions")).toMatchObject({
			documentView: "decisions",
			documentVisible: true,
			conversationVisible: false,
		});
	});

	it("keeps a desktop preference while compact Conversation comes and goes", () => {
		let state: WorkspaceState = {
			conversationOpen: false,
			desktopConversationOpen: true,
		};

		state = transitionWorkspace(state, { type: "set-conversation", open: true });
		expect(presentWorkspace(state, "compact", "plan")).toMatchObject({
			documentVisible: false,
			conversationVisible: true,
		});
		state = transitionWorkspace(state, { type: "set-conversation", open: false });
		expect(state.desktopConversationOpen).toBe(true);
		expect(presentWorkspace(state, "split", "plan").conversationVisible).toBe(true);
	});

	it("restores Background Work after compact Conversation closes", () => {
		let state: WorkspaceState = {
			conversationOpen: true,
			desktopConversationOpen: false,
		};
		state = transitionWorkspace(state, { type: "set-conversation", open: false });
		expect(presentWorkspace(state, "compact", "background-work")).toMatchObject({
			documentView: "background-work",
			documentVisible: true,
			conversationVisible: false,
		});
	});

	it("shows Conversation as the only compact destination on tablets", () => {
		let state: WorkspaceState = {
			conversationOpen: true,
			desktopConversationOpen: true,
		};

		expect(presentWorkspace(state, "compact", "decisions")).toMatchObject({
			documentView: "decisions",
			documentVisible: false,
			conversationVisible: true,
			separatorVisible: false,
		});
	});
});
