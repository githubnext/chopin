import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { NavigationIcon, ProjectSidebar, toggleCollapsedProjectIds } from "./project-sidebar";
import { Header } from "./room-workspace";

import type { ComponentProps } from "react";

describe("the Figma navigation chrome", () => {
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

	test("uses a pen for document creation and a plus for adding a Project", () => {
		let markup = renderToStaticMarkup(createElement(ProjectSidebar, {
			canCreateDocument: true,
			creatingNewDocument: false,
			creatingProjectIds: new Set<string>(),
			onAccount: () => {},
			onAddProject: () => {},
			onCollapse: () => {},
			onCreateDocument: () => {},
			onLoadMore: () => {},
			onNewDocument: () => {},
			onOpenDocument: () => {},
			onRenameDocument: () => {},
			onSearch: () => {},
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
			user: { avatarUrl: "/user.png", id: "user-one", login: "MaggieAppleton" },
		}));

		expect(markup).toMatch(
			/<button[^>]*class="project-sidebar-primary-action"[^>]*>.*?new-document\.svg.*?New document<\/span>/s,
		);
		expect(markup).toMatch(/height="18" src="[^"]*chopin\.svg" width="18"/);
		expect(markup).toMatch(
			/aria-label="New document in testing-sql-transcripts"[^>]*>.*?new-document\.svg/s,
		);
		expect(markup).toContain("book-bookmark.svg");
		expect(markup).toMatch(/class="opacity-50"[^>]*src="[^"]*book-bookmark\.svg"/);
		expect(markup).not.toContain('src="/repository.png"');
		expect(markup).toMatch(
			/aria-label="Add Project"[^>]*>.*?class="size-3\.5"[^>]*add-project\.svg/s,
		);
		expect(markup).toMatch(
			/<button[^>]*class="project-sidebar-primary-action"[^>]*>.*?search\.svg.*?Search<\/span>/s,
		);
		expect(markup).toContain('class="project-sidebar-projects gap-2"');
		expect(markup).toMatch(
			/<button[^>]*aria-expanded="true"[^>]*class="project-sidebar-project-disclosure[^>]*>.*?book-bookmark\.svg.*?testing-sql-transcripts<\/span><\/button>/s,
		);
		expect(markup).toMatch(
			/<\/button><button[^>]*aria-label="New document in testing-sql-transcripts"/s,
		);
	});

	test("exposes whether the account menu is open", () => {
		let props = {
			canCreateDocument: false,
			creatingNewDocument: false,
			creatingProjectIds: new Set<string>(),
			onAccount: () => {},
			onAddProject: () => {},
			onCollapse: () => {},
			onCreateDocument: () => {},
			onLoadMore: () => {},
			onNewDocument: () => {},
			onOpenDocument: () => {},
			onRenameDocument: () => {},
			onSearch: () => {},
			projects: [],
			user: { avatarUrl: "", id: "user-one", login: "MaggieAppleton" },
		} satisfies ComponentProps<typeof ProjectSidebar>;
		let closed = renderToStaticMarkup(createElement(ProjectSidebar, props));
		let open = renderToStaticMarkup(createElement(ProjectSidebar, {
			...props,
			accountMenu: createElement("div", { role: "menu" }),
		}));

		expect(closed).toMatch(/class="project-sidebar-account" aria-expanded="false"/);
		expect(open).toMatch(/class="project-sidebar-account" aria-expanded="true"/);
	});

	test("offers explicit pagination when a Project has more documents", () => {
		let markup = renderToStaticMarkup(createElement(ProjectSidebar, {
			canCreateDocument: true,
			creatingNewDocument: false,
			creatingProjectIds: new Set<string>(),
			onAccount: () => {},
			onAddProject: () => {},
			onCollapse: () => {},
			onCreateDocument: () => {},
			onLoadMore: () => {},
			onNewDocument: () => {},
			onOpenDocument: () => {},
			onRenameDocument: () => {},
			onSearch: () => {},
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
			user: { avatarUrl: "", id: "user-one", login: "MaggieAppleton" },
		}));

		expect(markup).toContain('aria-label="Load more documents in testing-sql-transcripts"');
	});

	test("keeps the document header to one project icon and document trigger", () => {
		let props = {
			canEdit: true,
			label: "Hushed mountain",
			members: [{ handle: "MaggieAppleton", client: "tab-one" }],
			onRename: () => {},
		};
		let markup = renderToStaticMarkup(createElement(Header, props));

		expect(markup).toMatch(/class="opacity-50"[^>]*src="[^"]*book-bookmark\.svg"/);
		expect(markup).not.toContain('src="/repository.png"');
		expect(markup).toContain('aria-label="Document: Hushed mountain"');
		expect(markup).toContain('aria-label="Rename Hushed mountain"');
		expect(markup).toContain("gap-0.5");
		expect(markup).toContain("lg:h-[calc(50px+env(safe-area-inset-top))]");
		expect(markup).toContain('style="width:24px;height:24px"');
		expect(markup).not.toContain('aria-label="Open Projects sidebar"');
		expect(markup).not.toContain('aria-label="Repository:');
		expect(markup).not.toContain('href="/"');
		expect(markup).not.toContain("hairline-b");
	});
});
