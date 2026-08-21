import { describe, expect, it } from "bun:test";

import { presentWorkspace, transitionWorkspace, workspaceMode } from "./workspace-model";

import type { WorkspaceState } from "./workspace-model";

type MatchMedia = (query: string) => { matches: boolean };

function mediaAt(width: number): MatchMedia {
	return query => {
		let maximum = /\(max-width: (\d+)px\)/.exec(query);
		return { matches: maximum !== null && width <= Number(maximum[1]) };
	};
}

describe("adaptive workspace", () => {
	it("classifies the media queries production reads at each boundary", () => {
		expect([1039, 1040].map(width => workspaceMode(mediaAt(width)))).toEqual([
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
