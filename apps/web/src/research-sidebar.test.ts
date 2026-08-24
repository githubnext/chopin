import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ProjectSidebar } from "./project-sidebar";

import type { ComponentProps } from "react";
import type { Research } from "@chopin/protocol";
import type * as Api from "./api";

let channel: Api.Channel = {
	id: "channel-one",
	repositoryId: "R_one",
	repositoryOwner: "acme",
	repositoryName: "one",
	title: "Release plan",
	slug: "release-plan",
	createdBy: "user-one",
	revision: 1,
	createdAt: "2026-08-20T00:00:00.000Z",
	updatedAt: "2026-08-23T00:00:00.000Z",
};

function workspace(id: string, title: string, createdAt: string): Research.WorkspaceSummary {
	return {
		id,
		channelId: channel.id,
		title,
		proposedQuestion: title,
		origin: "sidebar",
		createdBy: "user-one",
		revision: 0,
		createdAt,
		updatedAt: createdAt,
	};
}

let older = workspace("research-older", "Older evidence", "2026-08-21T00:00:00.000Z");
let newer = workspace("research-newer", "Newer evidence", "2026-08-22T00:00:00.000Z");

let props = {
	canCreateDocument: true,
	creatingNewDocument: false,
	creatingProjectIds: new Set<string>(),
	currentDocumentId: channel.id,
	onAccount: () => {},
	onAddProject: () => {},
	onCollapse: () => {},
	onCreateDocument: () => {},
	onDocumentAction: () => {},
	onLoadMore: () => {},
	onNewDocument: () => {},
	onNewResearch: () => {},
	onSearch: () => {},
	onCatalogueModeChange: () => {},
	projects: [{
		documents: { status: "ready" as const, channels: [channel] },
		project: {
			available: true,
			position: 0,
			repositoryId: "R_one",
			repositoryName: "one",
			repositoryOwner: "acme",
			repository: {
				id: "R_one",
				owner: "acme",
				name: "one",
				fullName: "acme/one",
				permissions: { pull: true, push: true, admin: false },
			},
		},
	}],
	research: new Map([[channel.id, {
		channel,
		workspaces: [older, newer],
	}]]),
	catalogueMode: "active",
	user: { avatarUrl: "", id: "user-one", login: "octocat" },
} satisfies ComponentProps<typeof ProjectSidebar>;

describe("research sidebar hierarchy", () => {
	it("uses one real current-page link for the document route", () => {
		let markup = renderToStaticMarkup(createElement(ProjectSidebar, props));

		expect(markup.match(/aria-current="page"/g)).toHaveLength(1);
		expect(markup).toContain(
			'<a aria-current="page" class="project-sidebar-document-link min-w-0 flex-1 text-left text-sm font-medium" href="/documents/acme/one/release-plan">',
		);
		expect(markup).not.toContain('role="tree"');
	});

	it("marks the parent as an active ancestor and only the child as current", () => {
		let markup = renderToStaticMarkup(createElement(ProjectSidebar, {
			...props,
			currentResearchWorkspaceId: newer.id,
		}));

		expect(markup.match(/aria-current="page"/g)).toHaveLength(1);
		expect(markup).toContain("project-sidebar-document-ancestor");
		expect(markup).toContain(
			`aria-current="page" class="project-sidebar-research-link project-sidebar-research-current" href="/documents/acme/one/release-plan/research/${newer.id}"`,
		);
		expect(markup.indexOf(newer.title)).toBeLessThan(markup.indexOf(older.title));
		expect(markup).toContain('aria-label="New research in Release plan"');
		expect(markup).toContain('aria-label="Actions for Release plan"');
	});

	it("keeps archived rows free of research creation and viewer management", () => {
		let archived = { ...channel, archivedAt: "2026-08-23T00:00:00.000Z" };
		let writer = renderToStaticMarkup(createElement(ProjectSidebar, {
			...props,
			projects: [{
				...props.projects[0]!,
				documents: { status: "ready", channels: [archived] },
			}],
			catalogueMode: "archived",
		}));
		let viewer = renderToStaticMarkup(createElement(ProjectSidebar, {
			...props,
			projects: [{
				...props.projects[0]!,
				documents: { status: "ready", channels: [archived] },
				project: {
					...props.projects[0]!.project,
					repository: {
						...props.projects[0]!.project.repository!,
						permissions: { pull: true, push: false, admin: false },
					},
				},
			}],
			catalogueMode: "archived",
		}));

		expect(writer).toContain('aria-label="Actions for Release plan"');
		expect(writer).not.toContain('aria-label="New research in Release plan"');
		expect(viewer).not.toContain('aria-label="Actions for Release plan"');
	});
});
