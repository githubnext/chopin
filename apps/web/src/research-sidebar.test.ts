import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { documentGroups, ProjectSidebar } from "./project-sidebar";

import type { ComponentProps } from "react";
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
	descriptionRevision: 1,
	description: "Coordinates the release readiness work.",
};

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
	catalogueMode: "active",
	user: { avatarUrl: "", id: "user-one", login: "octocat" },
} satisfies ComponentProps<typeof ProjectSidebar>;

describe("document sidebar hierarchy", () => {
	it("groups children beneath present parents without disturbing either order", () => {
		let secondParent = { ...channel, id: "channel-two", slug: "second", title: "Second" };
		let firstChild = {
			...channel,
			id: "child-one",
			parentChannelId: channel.id,
			slug: "child-one",
			title: "First child",
		};
		let secondChild = {
			...firstChild,
			id: "child-two",
			slug: "child-two",
			title: "Second child",
		};
		let orphan = {
			...firstChild,
			id: "orphan",
			parentChannelId: "parent-on-another-page",
		};

		expect(
			documentGroups(
				[secondParent, firstChild, channel, orphan, secondChild],
				false,
			).map(group => ({
				parent: group.parent.id,
				children: group.children.map(child => child.id),
			})),
		).toEqual([
			{ parent: secondParent.id, children: [] },
			{ parent: channel.id, children: [firstChild.id, secondChild.id] },
		]);
	});

	it("filters archived parents and children before grouping", () => {
		let archivedParent = {
			...channel,
			id: "archived-parent",
			archivedAt: "2026-08-24T00:00:00.000Z",
		};
		let archivedChild = {
			...channel,
			id: "archived-child",
			parentChannelId: archivedParent.id,
			archivedAt: "2026-08-24T00:00:00.000Z",
		};
		let activeChild = { ...archivedChild, id: "active-child", archivedAt: undefined };

		expect(documentGroups([channel, archivedParent, archivedChild, activeChild], false))
			.toEqual([{ parent: channel, children: [] }]);
		expect(documentGroups([channel, archivedParent, archivedChild, activeChild], true))
			.toEqual([{ parent: archivedParent, children: [archivedChild] }]);
	});

	it("renders an ordinary child row with the same durable route as its ready card", () => {
		let child = {
			...channel,
			id: "child-one",
			parentChannelId: channel.id,
			title: "Source review",
			slug: "source-review",
		};
		let markup = renderToStaticMarkup(createElement(ProjectSidebar, {
			...props,
			currentDocumentId: child.id,
			projects: [{
				...props.projects[0]!,
				documents: { status: "ready", channels: [channel, child] },
			}],
		}));

		expect(markup.match(/aria-current="page"/g)).toHaveLength(1);
		expect(markup).toContain("project-sidebar-document-ancestor");
		expect(markup).toContain("project-sidebar-child group/document project-sidebar-child-current");
		expect(markup).toContain(
			'aria-current="page" class="project-sidebar-child-link" href="/documents/acme/one/release-plan/children/source-review"',
		);
		expect(markup).toContain("Source review");
		expect(markup).toContain('aria-label="Actions for Source review"');
	});

	it("uses one real current-page link for the document route", () => {
		let markup = renderToStaticMarkup(createElement(ProjectSidebar, props));

		expect(markup.match(/aria-current="page"/g)).toHaveLength(1);
		expect(markup).toContain(
			'<a aria-current="page" class="project-sidebar-document-link min-w-0 flex-1 text-left text-sm font-medium" href="/documents/acme/one/release-plan">',
		);
		expect(markup).not.toContain('role="tree"');
		expect(markup).toContain("Coordinates the release readiness work.");
		expect(markup).toContain("block truncate font-normal text-text-quaternary");
	});

	it("omits the standalone research launcher and workspace rows", () => {
		let markup = renderToStaticMarkup(createElement(ProjectSidebar, props));

		expect(markup.match(/aria-current="page"/g)).toHaveLength(1);
		expect(markup).not.toContain("project-sidebar-document-ancestor");
		expect(markup).not.toContain("project-sidebar-research-link");
		expect(markup).not.toContain('href="/documents/acme/one/release-plan/research/');
		expect(markup).not.toContain('aria-label="New research in Release plan"');
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
