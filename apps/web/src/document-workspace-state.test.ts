import { expect, test } from "bun:test";

import {
	initialDocumentWorkspaceState,
	transitionDocumentWorkspace,
} from "./document-workspace-state";

import type { ChannelDetail } from "./api";

function detail(id: string, slug: string, parentChannelId?: string): ChannelDetail {
	return {
		canEdit: true,
		canManage: true,
		channel: {
			createdAt: "2026-08-27T00:00:00.000Z",
			createdBy: "user-one",
			descriptionRevision: 0,
			id,
			...(parentChannelId ? { parentChannelId } : {}),
			repositoryId: "R_score",
			repositoryName: "score",
			repositoryOwner: "octo-org",
			revision: 0,
			slug,
			title: slug,
			updatedAt: "2026-08-27T00:00:00.000Z",
		},
		repository: {
			defaultBranch: "main",
			fullName: "octo-org/score",
			id: "R_score",
			name: "score",
			owner: "octo-org",
			permissions: { admin: false, pull: true, push: true },
			private: false,
			url: "https://github.com/octo-org/score",
		},
	};
}

test("one state transition owns parent retention across the child lifecycle", () => {
	let parent = detail("parent-one", "canonical-parent");
	let child = detail("child-one", "canonical-child", parent.channel.id);
	let route = {
		childSlug: "requested-child",
		owner: "octo-org",
		page: "child" as const,
		parentSlug: "requested-parent",
		repository: "score",
	};
	let state = transitionDocumentWorkspace(initialDocumentWorkspaceState(), {
		parent,
		route,
		type: "parent-ready",
	});
	expect(state).toMatchObject({
		loaded: { parent },
		presentation: "open",
		status: "ready",
	});

	state = transitionDocumentWorkspace(state, { child, parent, route, type: "ready" });
	expect(state).toMatchObject({
		loaded: { child, parent },
		presentation: "open",
		status: "ready",
	});

	state = transitionDocumentWorkspace(state, {
		route: {
			owner: "octo-org",
			page: "document",
			repository: "score",
			slug: "canonical-parent",
		},
		type: "route",
	});
	expect(state).toMatchObject({
		loaded: { child, parent },
		presentation: "closing",
		status: "ready",
	});

	state = transitionDocumentWorkspace(state, { type: "closed" });
	expect(state).toMatchObject({
		loaded: { parent },
		presentation: "closed",
		status: "ready",
	});
	expect(state.status === "ready" && state.loaded.child).toBeUndefined();
});
