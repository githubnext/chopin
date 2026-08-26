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

const childPresentation = { label: "Source review", onClose() {}, type: "child" } as const;
const documentPresentation = { type: "document" } as const;

function mediaAt(width: number): MatchMedia {
	return query => {
		let maximum = /\(max-width: (\d+)px\)/.exec(query);
		return { matches: maximum !== null && width <= Number(maximum[1]) };
	};
}

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

	it("starts a child with Chat collapsed without inheriting the desktop preference", () => {
		expect(initialWorkspaceState(workspaceProfile(childPresentation), true)).toEqual({
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
		expect(workspaceDestinations()).toEqual([
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
		expect(workspaceDestinations()).toEqual([
			"chat",
			"plan",
			"decisions",
		]);
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

	it("shows Chat as the only compact destination on tablets", () => {
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
});
