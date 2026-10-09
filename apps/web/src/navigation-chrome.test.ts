import { describe, expect, test } from "bun:test";
import { ChevronIcon, DocumentIcon, PlusIcon, SearchIcon } from "@chopin/icons";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
	menuItemTarget,
	NavigationIcon,
	ProjectSidebar,
	toggleCollapsedProjectIds,
} from "./project-sidebar";
import { ProjectSidebarExpandButton } from "./project-sidebar-chrome";
import { Header } from "./room-workspace";

import type { ComponentProps } from "react";

describe("the Figma navigation chrome", () => {
	test("uses the standard fourteen-pixel glyph in an icon button", () => {
		let markup = renderToStaticMarkup(createElement(ProjectSidebarExpandButton, {
			onExpand: () => {},
		}));

		expect(markup).toContain('height="14"');
		expect(markup).toContain('width="14"');
	});

	test("renders sidebar control glyphs at fourteen pixels", () => {
		let markup = renderToStaticMarkup(createElement(NavigationIcon, { src: "/control.svg" }));

		expect(markup).toContain('width="14"');
		expect(markup).toContain('height="14"');
	});

	test("toggles one Project without changing the other collapsed Projects", () => {
		let collapsed = new Set(["R_other"]);
		let closed = toggleCollapsedProjectIds(collapsed, "R_test");
		let reopened = toggleCollapsedProjectIds(closed, "R_test");

		expect([...closed]).toEqual(["R_other", "R_test"]);
		expect([...reopened]).toEqual(["R_other"]);
		expect([...collapsed]).toEqual(["R_other"]);
	});

	test("uses plus icons for document creation and a compact add-project icon", () => {
		let markup = renderToStaticMarkup(createElement(ProjectSidebar, {
			canCreateDocument: true,
			pendingCreations: new Map(),
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
				documents: { status: "ready", channels: [] },
				project: {
					available: true,
					position: 0,
					repositoryId: "R_test",
					repositoryName: "testing-sql-transcripts",
					repositoryOwner: "MaggieAppleton",
					repository: {
						fullName: "MaggieAppleton/testing-sql-transcripts",
						id: "R_test",
						name: "testing-sql-transcripts",
						owner: "MaggieAppleton",
						ownerAvatarUrl: "/repository.png",
						permissions: { admin: true, pull: true, push: true },
					},
				},
			}],
			catalogueMode: "active",
			user: { avatarUrl: "/user.png", id: "user-one", login: "MaggieAppleton" },
		}));

		let plus = renderToStaticMarkup(createElement(PlusIcon));
		let primary = markup.match(
			/<button[^>]*class="project-sidebar-primary-action"[^>]*>.*?<\/button>/s,
		)?.[0];
		expect(primary).toContain(plus);
		expect(primary).toContain("New document</span>");
		expect(markup).toMatch(/height="14" src="[^"]*chopin\.svg" width="14"/);
		let projectAction = markup.match(
			/<button[^>]*aria-label="New document in testing-sql-transcripts"[^>]*>.*?<\/button>/s,
		)?.[0];
		expect(projectAction).toContain(renderToStaticMarkup(createElement(PlusIcon, { size: 12 })));
		expect(markup).toContain(
			renderToStaticMarkup(createElement(DocumentIcon, {
				className: "project-sidebar-project-repository-icon",
			})),
		);
		expect(markup).not.toContain('src="/repository.png"');
		expect(markup).toMatch(
			/aria-label="Add project"[^>]*>.*?class="size-3"[^>]*add-project\.svg/s,
		);
		expect(markup).toMatch(
			/<button[^>]*class="project-sidebar-primary-action"[^>]*>.*?Search<\/span>/s,
		);
		expect(markup).toContain(renderToStaticMarkup(createElement(SearchIcon, { size: 12 })));
		expect(markup).toContain('class="project-sidebar-projects gap-2"');
		expect(markup).toMatch(
			/<button[^>]*aria-expanded="true"[^>]*class="project-sidebar-project-disclosure[^>]*>.*?testing-sql-transcripts<\/span><\/button>/s,
		);
		expect(markup).toContain('data-feedback-icon="open"');
		expect(markup).toContain('data-motion-feedback="icon"');
		expect(markup).toMatch(
			/<button[^>]*aria-controls="[^"]+"[^>]*class="project-sidebar-project-disclosure/s,
		);
		expect(markup).toContain('data-motion-disclosure="projects"');
		expect(markup).toMatch(
			/<\/button><button[^>]*aria-label="New document in testing-sql-transcripts"/s,
		);
	});

	test("steps through account menu items and wraps", () => {
		expect(menuItemTarget("ArrowDown", 0, 3)).toBe(1);
		expect(menuItemTarget("ArrowDown", 2, 3)).toBe(0);
		expect(menuItemTarget("ArrowUp", 0, 3)).toBe(2);
		expect(menuItemTarget("Home", 2, 3)).toBe(0);
		expect(menuItemTarget("End", 0, 3)).toBe(2);
	});

	test("exposes whether the account menu is open", () => {
		let props = {
			canCreateDocument: false,
			pendingCreations: new Map(),
			onAccount: () => {},
			onAddProject: () => {},
			onCollapse: () => {},
			onCreateDocument: () => {},
			onDocumentAction: () => {},
			onLoadMore: () => {},
			onNewDocument: () => {},
			onSearch: () => {},
			onCatalogueModeChange: () => {},
			projects: [],
			catalogueMode: "active",
			user: { avatarUrl: "", id: "user-one", login: "MaggieAppleton" },
		} satisfies ComponentProps<typeof ProjectSidebar>;
		let closed = renderToStaticMarkup(createElement(ProjectSidebar, props));
		let open = renderToStaticMarkup(createElement(ProjectSidebar, {
			...props,
			accountMenu: {
				className: "",
				closing: false,
				onDismiss() {},
				onShortcuts() {},
				onSignOut() {},
			},
		}));

		expect(closed).toMatch(/class="project-sidebar-account" aria-expanded="false"/);
		expect(open).toMatch(/class="project-sidebar-account" aria-expanded="true"/);
		expect(open).toContain("Keyboard shortcuts");
		expect(open).toContain('<kbd aria-hidden="true">?</kbd>Keyboard shortcuts');
	});

	test("offers explicit pagination when a Project has more documents", () => {
		let markup = renderToStaticMarkup(createElement(ProjectSidebar, {
			canCreateDocument: true,
			pendingCreations: new Map(),
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
				documents: { status: "ready", channels: [], nextCursor: "next-page" },
				project: {
					available: true,
					position: 0,
					repositoryId: "R_test",
					repositoryName: "testing-sql-transcripts",
					repositoryOwner: "MaggieAppleton",
				},
			}],
			catalogueMode: "active",
			user: { avatarUrl: "", id: "user-one", login: "MaggieAppleton" },
		}));

		expect(markup).toContain('aria-label="Load more documents in testing-sql-transcripts"');
		expect(markup).not.toContain("No documents yet.");
	});

	test("keeps the document header to one project icon and document trigger", () => {
		let props = {
			canManage: true,
			label: "Hushed mountain",
			members: [{ handle: "MaggieAppleton", client: "tab-one" }],
			onAction: () => {},
			onEditingChange: () => {},
			onRenamed: () => {},
			presentation: { type: "document" as const },
			room: "room-one",
		};
		let markup = renderToStaticMarkup(createElement(Header, props));

		expect(
			markup.split(renderToStaticMarkup(createElement(DocumentIcon, { className: "shrink-0" }))),
		).toHaveLength(2);
		expect(markup).not.toContain('src="/repository.png"');
		expect(markup).toContain('aria-label="Document: Hushed mountain"');
		expect(markup).toContain('aria-label="Actions for Hushed mountain"');
		expect(markup).toContain('aria-label="Rename Hushed mountain"');
		expect(markup).toContain("gap-0.5");
		expect(markup).not.toContain("safe-area-inset-top");
		expect(markup).toContain('style="width:24px;height:24px;');
		expect(markup).not.toContain('aria-label="Show sidebar"');
		expect(markup).not.toContain('aria-label="Repository:');
		expect(markup).not.toContain('href="/"');
		expect(markup).not.toContain("hairline-b");
	});

	test("swaps the title for an inline field while renaming", () => {
		let markup = renderToStaticMarkup(createElement(Header, {
			canManage: true,
			editing: "rename",
			label: "Hushed mountain",
			members: [],
			onAction() {},
			onEditingChange() {},
			onRenamed() {},
			presentation: { type: "document" },
			room: "room-one",
		}));

		expect(markup).toContain(">Document title</label>");
		expect(markup).toContain('value="Hushed mountain"');
		expect(markup).toContain('placeholder="Untitled"');
		expect(markup).not.toContain('aria-label="Rename Hushed mountain"');
		expect(markup).not.toContain(">Save</button>");
	});

	test("turns the parent title into a child-document breadcrumb", () => {
		let markup = renderToStaticMarkup(createElement(Header, {
			canManage: true,
			label: "Release plan",
			members: [{ handle: "MaggieAppleton", client: "tab-one" }],
			onAction() {},
			onEditingChange() {},
			onRenamed() {},
			room: "room-one",
			presentation: {
				childLabel: "Source review",
				onChildClose() {},
				type: "parent-with-child",
			},
		}));

		expect(markup).not.toContain('aria-label="Back to Release plan"');
		expect(markup).toContain('aria-label="Return to Release plan"');
		expect(markup).toContain('aria-label="Child document: Source review"');
		expect(markup).toContain('aria-label="People here: MaggieAppleton"');
		expect(markup).not.toContain('aria-label="Actions for Release plan"');
		expect(markup).toContain(renderToStaticMarkup(createElement(ChevronIcon, {
			className: "document-breadcrumb-separator shrink-0",
		})));
		expect(markup).toContain('class="document-breadcrumb-separator shrink-0"');
		expect(markup).not.toContain(">›</span>");
	});

	test("labels archived headers while keeping management actions from viewers", () => {
		let props = {
			archivedAt: "2026-08-23T00:00:00.000Z",
			label: "Archived brief",
			members: [],
			onAction: () => {},
			onEditingChange: () => {},
			onRenamed: () => {},
			presentation: { type: "document" as const },
			room: "room-one",
		};
		let manager = renderToStaticMarkup(createElement(Header, { ...props, canManage: true }));
		let viewer = renderToStaticMarkup(createElement(Header, { ...props, canManage: false }));

		expect(manager).toContain(">Archived</span>");
		expect(manager).toContain('aria-label="Actions for Archived brief"');
		expect(manager).toContain(">Restore</button>");
		expect(manager).not.toContain('aria-label="Rename Archived brief"');
		expect(viewer).toContain(">Archived</span>");
		expect(viewer).not.toContain('aria-label="Actions for Archived brief"');
		expect(viewer).not.toContain(">Restore</button>");
		expect(viewer).not.toContain('aria-label="Rename Archived brief"');
	});
});
