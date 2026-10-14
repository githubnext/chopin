import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ApiError } from "./api";
import {
	anchoredChildPaths,
	AnchoredChildSurface,
	animationsSettled,
	childCloseAction,
	childFocusTransition,
	childHistoryState,
	childPresentation,
	rebaseChildHistoryState,
} from "./anchored-child-surface";
import { hostedRoute, retryableChannelFailure } from "./hosted";
import { githubLoginHref } from "./hosted-login";
import { prepareDocumentLoad, validatedChildPath } from "./document-loader";
import { Workspace } from "./workspace";

import type { ChannelDetail } from "./api";

const workspaceIds = {
	heading: {
		build: "workspace-build-heading",
		chat: "workspace-chat-heading",
		decisions: "workspace-decisions-heading",
		plan: "workspace-plan-heading",
	},
	pane: { chat: "workspace-chat-pane" },
};

function detail(
	id: string,
	slug: string,
	parentChannelId?: string,
	repositoryId = "R_score",
): ChannelDetail {
	return {
		repository: {
			id: repositoryId,
			owner: "octo-org",
			name: "score",
			fullName: "octo-org/score",
			private: false,
			url: "https://github.com/octo-org/score",
			defaultBranch: "main",
			permissions: { pull: true, push: true, admin: false },
		},
		canEdit: true,
		canManage: true,
		channel: {
			descriptionRevision: 0,
			id,
			repositoryId,
			repositoryOwner: "octo-org",
			repositoryName: "score",
			...(parentChannelId ? { parentChannelId } : {}),
			title: slug,
			slug,
			createdBy: "user-one",
			revision: 0,
			createdAt: "2026-08-24T00:00:00.000Z",
			updatedAt: "2026-08-24T00:00:00.000Z",
		},
	};
}

let toolbarOf = (markup: string) =>
	markup.slice(
		markup.indexOf('data-document-title-bar="true"'),
		markup.indexOf('data-document-view="plan"'),
	);

describe("hosted routes", () => {
	it("recognizes canonical document routes and rejects the removed research route", () => {
		expect(hostedRoute("/")).toEqual({ page: "repositories" });
		expect(hostedRoute("/documents/octo-org/score")).toEqual({
			page: "repository",
			owner: "octo-org",
			repository: "score",
		});
		expect(hostedRoute("/documents/octo-org/score/r%C3%A9sum%C3%A9-%E8%A8%88%E7%94%BB"))
			.toEqual({
				page: "document",
				owner: "octo-org",
				repository: "score",
				slug: "résumé-計画",
			});
		expect(hostedRoute(
			"/documents/octo-org/score/r%C3%A9sum%C3%A9-%E8%A8%88%E7%94%BB/research/workspace%3A1",
		)).toEqual({ page: "missing" });
		expect(hostedRoute("/repositories/octo-org/score")).toEqual({
			page: "repository",
			owner: "octo-org",
			repository: "score",
		});
		expect(hostedRoute("/repositories/github%20next/chopin")).toEqual({
			page: "repository",
			owner: "github next",
			repository: "chopin",
		});
		expect(hostedRoute("/channels/019c1234-1234-4123-8123-123456789abc")).toEqual({
			page: "channel",
			id: "019c1234-1234-4123-8123-123456789abc",
		});
		expect(hostedRoute("/channels/019c1234-1234-5123-8123-123456789abc")).toEqual({
			page: "channel",
			id: "019c1234-1234-5123-8123-123456789abc",
		});
		expect(hostedRoute("/plans/main")).toEqual({ page: "missing" });
		expect(hostedRoute("/documents/octo-org/score/plan/extra"))
			.toEqual({ page: "missing" });
		expect(hostedRoute("/documents/octo-org/score/plan/research"))
			.toEqual({ page: "missing" });
	});

	it("recognizes a child route before the ordinary document route", () => {
		expect(hostedRoute(
			"/documents/octo-org/score/release-plan/children/source%20review",
		)).toEqual({
			page: "child",
			owner: "octo-org",
			repository: "score",
			parentSlug: "release-plan",
			childSlug: "source review",
		});
	});

	it("accepts direct child entry only for its recorded parent and repository", () => {
		let parent = detail("parent-one", "canonical-parent");
		let child = detail("child-one", "canonical-child", parent.channel.id);

		expect(validatedChildPath(child, parent)).toBe(
			"/documents/octo-org/score/canonical-parent/children/canonical-child",
		);
		for (
			let invalid of [
				detail("child-one", "canonical-child"),
				detail("child-one", "canonical-child", "different-parent"),
				detail("child-one", "canonical-child", parent.channel.id, "R_other"),
			]
		) {
			expect(() => validatedChildPath(invalid, parent)).toThrow(ApiError);
			try {
				validatedChildPath(invalid, parent);
			} catch (error) {
				expect((error as ApiError).status).toBe(404);
			}
		}
	});
});

describe("anchored child lifecycle", () => {
	it("restores only the close attempt that reaches its own mounted parent", () => {
		let opener = { current: null };
		let state = childFocusTransition({ generation: 0 }, {
			type: "begin",
			opener,
			parentId: "parent-one",
			parentPath: "/documents/octo-org/score/parent-one",
		});
		let token = { generation: 1, parentId: "parent-one" };
		state = childFocusTransition(state, {
			type: "route",
			pathname: "/documents/octo-org/score/parent-one",
		});
		state = childFocusTransition(state, { type: "restore", token });

		expect(state.attempt).toMatchObject({
			generation: 1,
			parentId: "parent-one",
			phase: "deferred",
		});
		expect(childFocusTransition(state, { type: "restore", token })).toBe(state);
		let finished = childFocusTransition(state, { type: "finish", token });
		expect(finished).toEqual({
			generation: 1,
		});
		expect(childFocusTransition(finished, { type: "restore", token })).toBe(finished);
	});

	it("invalidates a close attempt on reopen, sibling, or different-document navigation", () => {
		for (
			let pathname of [
				"/documents/octo-org/score/parent-one/children/child-one",
				"/documents/octo-org/score/parent-one/children/child-two",
				"/documents/octo-org/score/parent-two",
			]
		) {
			let state = childFocusTransition({ generation: 0 }, {
				type: "begin",
				opener: { current: null },
				parentId: "parent-one",
				parentPath: "/documents/octo-org/score/parent-one",
			});
			let token = { generation: 1, parentId: "parent-one" };
			state = childFocusTransition(state, {
				type: "route",
				pathname: "/documents/octo-org/score/parent-one",
			});
			state = childFocusTransition(state, { type: "route", pathname });
			state = childFocusTransition(state, { type: "restore", token });

			expect(state).toEqual({ generation: 2 });
		}
	});

	it("ignores stale completion after a superseding close attempt", () => {
		let state = childFocusTransition({ generation: 0 }, {
			type: "begin",
			opener: { current: null },
			parentId: "parent-one",
			parentPath: "/documents/octo-org/score/parent-one",
		});
		let stale = { generation: 1, parentId: "parent-one" };
		state = childFocusTransition(state, {
			type: "begin",
			opener: { current: null },
			parentId: "parent-two",
			parentPath: "/documents/octo-org/score/parent-two",
		});

		expect(childFocusTransition(state, { type: "restore", token: stale })).toBe(state);
		expect(state.attempt?.generation).toBe(2);
	});

	it("coalesces repeated close requests until the child route changes", () => {
		let state = childFocusTransition({ generation: 0 }, {
			type: "begin",
			opener: { current: null },
			parentId: "parent-one",
			parentPath: "/documents/octo-org/score/parent-one",
		});
		let repeated = childFocusTransition(state, {
			type: "begin",
			opener: { current: null },
			parentId: "parent-one",
			parentPath: "/documents/octo-org/score/parent-one",
		});

		expect(repeated).toBe(state);
		repeated = childFocusTransition(repeated, {
			type: "route",
			pathname: "/documents/octo-org/score/parent-one/children/child-one",
		});
		expect(
			childFocusTransition(repeated, {
				type: "begin",
				opener: { current: null },
				parentId: "parent-one",
				parentPath: "/documents/octo-org/score/parent-one",
			}).attempt?.generation,
		).toBe(3);
	});

	it("settles a child close when an animation is cancelled", async () => {
		let cancelled = Promise.reject(new DOMException("The animation was aborted", "AbortError"));
		cancelled.catch(() => {});
		let settled = false;
		await animationsSettled([{ finished: cancelled }, { finished: Promise.resolve() }])
			.then(() => {
				settled = true;
			});
		expect(settled).toBe(true);
	});

	it("draws a Lift card with a title bar and a Zoom layer without one", () => {
		let entry = {
			id: "child-room",
			label: "Source review",
			node: createElement("div", { "data-workspace-room": "child-room" }),
		};
		let lift = renderToStaticMarkup(createElement(AnchoredChildSurface, {
			entries: [entry],
			motion: "lift",
			onClosed() {},
			presentation: "open",
		}));
		let zoom = renderToStaticMarkup(createElement(AnchoredChildSurface, {
			entries: [entry],
			motion: "zoom",
			onClosed() {},
			presentation: "open",
		}));

		expect(lift).toContain('class="anchored-child-layer" data-child-motion="lift"');
		expect(lift).toContain('style="--level:1;--depth:1"');
		expect(lift).toContain('aria-label="Child document: Source review"');
		// The child room draws its own title bar, so the surface adds none.
		expect(lift).not.toContain("anchored-child-title");
		expect(zoom).not.toContain("anchored-child-shadow");
		expect(zoom).toContain('data-workspace-room="child-room"');
	});

	let splitProps = {
		chat: createElement("div", null, "Chat body"),
		controls: createElement("div", null, "Document controls"),
		chatActivity: { busy: true, unread: 0 },
		decisions: createElement("div", null, "Decisions"),
		header: createElement("header", null, "Room header"),
		identity: "room",
		title: createElement("div", null, "Room title"),
		ids: workspaceIds,
		mode: "split" as const,
		onChatOpen() {},
		onDesktopChatOpen() {},
		onDestination() {},
		plan: createElement("div", null, "Paper"),
		presence: createElement("div", { "aria-label": "People here: ana", role: "group" }),
		presentation: { type: "document" as const },
		unanswered: 0,
		view: "plan" as const,
	};

	let withChild = (
		motion: "lift" | "zoom",
		view: "plan" | "decisions" = "plan",
		expanded = false,
	) =>
		renderToStaticMarkup(createElement(Workspace, {
			...splitProps,
			controls: createElement("button", { type: "button" }, "Decisions"),
			presentation: {
				child: createElement("div", { "data-layer": "" }, "Child layer"),
				childState: "open",
				motion,
				onChildClose() {},
				path: [{ id: "room", label: "Root" }, { id: "child-room", label: "Source review" }],
				type: "parent-with-child",
			},
			state: { chatOpen: false, desktopChatOpen: !expanded },
			view,
		}));

	it("Lift covers the root sheet below its title bar and leaves Chat and the title bar live", () => {
		let markup = withChild("lift");
		let main = markup.match(/<main[^>]*>/)?.[0];
		let swap = markup.match(/<div[^>]*data-workspace-document-swap[^>]*>/)?.[0];
		let titleBar = markup.match(/<div[^>]*data-document-title-bar[^>]*>/)?.[0];
		let views = markup.match(/<div[^>]*data-document-toolbar[^>]*>/)?.[0];
		let stack = markup.slice(markup.indexOf("workspace-document-stack"), markup.indexOf("<aside"));

		expect(markup).toContain('data-child-motion="lift"');
		expect(main).toContain('data-child-covered="true"');
		expect(swap).toContain('inert=""');
		expect(titleBar).not.toContain("inert");
		expect(views).toContain('inert=""');
		expect(markup.match(/<div[^>]*document-title-slot[^>]*>/)?.[0]).toContain('inert=""');
		expect(toolbarOf(markup)).toContain("People here: ana");
		expect(stack).toContain("workspace-child-scrim");
		expect(stack.indexOf("</main>")).toBeLessThan(stack.indexOf("Child layer"));
		expect(markup).not.toContain('aria-label="Document stack"');
		expect(markup.match(/<aside[^>]*>/)?.[0]).not.toContain("inert");
		expect(markup).not.toMatch(/<div[^>]*class="workspace-frame[^"]*"[^>]*inert/);
		expect(markup).not.toContain("data-paper-obscured");
	});

	it("Lift makes the peeking title bar itself a keyboard control back to the root", () => {
		let toolbar = toolbarOf(withChild("lift"));
		let back = toolbar.match(/<button[^>]*aria-label="Back to Root"[^>]*>/)?.[0];

		expect(back).toBeDefined();
		expect(back).toContain("workspace-tab-row-return");
		expect(back).not.toContain("tabindex");
		expect(toolbar.indexOf("Back to Root")).toBeLessThan(toolbar.indexOf("Room title"));
		expect(toolbar.indexOf("Room title")).toBeLessThan(toolbar.indexOf(">Decisions<"));
		expect(toolbarOf(withChild("zoom"))).not.toContain("workspace-tab-row-return");
	});

	it("keeps the root's title on the sheet over an expanded root while a child is open", () => {
		let markup = withChild("lift", "plan", true);

		expect(markup).toContain('data-document-expanded="true"');
		expect(markup).not.toContain("workspace-header-slot");
		expect(toolbarOf(markup)).toContain("Room title");
	});

	it("split Zoom puts the path in the title bar and folds the views away on Document", () => {
		let document = withChild("zoom");
		let decisions = withChild("zoom", "decisions");
		let plan = document.match(/<section[^>]*data-document-view="plan"[^>]*>/)?.[0];
		let views = document.match(/<div[^>]*data-document-toolbar[^>]*>/)?.[0];

		expect(document).not.toContain('aria-label="Document stack"');
		// The arrow is a pointer target only; the root crumb in the title is the keyboard's Back.
		let back = toolbarOf(document).match(/<button[^>]*document-title-back[^>]*>/)?.[0];
		expect(back).toContain('aria-hidden="true"');
		expect(back).toContain('tabindex="-1"');
		expect(toolbarOf(document).indexOf("document-title-back"))
			.toBeLessThan(toolbarOf(document).indexOf("Room title"));
		expect(views).toContain("data-folded");
		expect(views).toContain('inert=""');
		expect(plan).toContain("data-child-recede");
		expect(plan).toContain('inert=""');
		expect(document.match(/<main[^>]*>/)?.[0]).not.toContain("data-child-covered");
		expect(decisions.match(/<div[^>]*workspace-child-slot[^>]*>/)?.[0]).toContain("hidden");
		// Off Document the views return so the root's other views stay reachable.
		expect(decisions.match(/<div[^>]*data-document-toolbar[^>]*>/)?.[0]).not.toContain(
			"data-folded",
		);
	});

	it("compact Zoom keeps the stack bar on every view", () => {
		let compact = (view: "plan" | "decisions") =>
			renderToStaticMarkup(createElement(Workspace, {
				...splitProps,
				mode: "compact",
				presentation: {
					child: createElement("div", null, "Child layer"),
					childState: "open",
					motion: "zoom",
					onChildClose() {},
					path: [{ id: "room", label: "Root" }, { id: "child-room", label: "Source review" }],
					type: "parent-with-child",
				},
				state: { chatOpen: false, desktopChatOpen: true },
				view,
			}));
		let document = compact("plan");
		let decisions = compact("decisions");

		expect(document).toContain('aria-label="Document stack"');
		expect(document).toContain('aria-label="Back to Root"');
		expect(document).toContain('aria-current="page">Source review<');
		expect(document).not.toContain("data-document-title-bar");
		expect(decisions).toContain('aria-label="Document stack"');
		expect(decisions).toMatch(/<button aria-current="page"[^>]*><span[^>]*>Source review</);
	});

	it("orders the title bar expand, title, presence, then the views, with no ground header", () => {
		let markup = renderToStaticMarkup(createElement(Workspace, {
			...splitProps,
			state: { chatOpen: false, desktopChatOpen: true },
		}));
		let toolbar = toolbarOf(markup);

		expect(markup).not.toContain("data-chat-header");
		expect(markup).not.toContain("data-chat-identity");
		expect(markup).not.toContain('aria-label="Hide chat"');
		expect(markup).toMatch(/<h2 class="sr-only" id="[^"]+" tabindex="-1">Chat<\/h2>/);
		expect(toolbar).toContain('aria-label="Expand document"');
		expect(toolbar.indexOf("Expand document")).toBeLessThan(toolbar.indexOf("Room title"));
		expect(toolbar.indexOf("Room title")).toBeLessThan(toolbar.indexOf("People here: ana"));
		expect(toolbar.indexOf("People here: ana")).toBeLessThan(toolbar.indexOf("Document controls"));
		expect(markup).toContain('aria-label="Resize chat"');
		expect(markup).not.toContain("Room header");
		expect(markup).not.toContain("data-document-expanded");
		expect(markup).toMatch(/class="workspace-root[^"]*"[^>]*style="--chat-width:\d+px"/);
	});

	it("trades Chat for a Chat button when expanded and keeps the title", () => {
		let markup = renderToStaticMarkup(createElement(Workspace, {
			...splitProps,
			state: { chatOpen: false, desktopChatOpen: false },
		}));
		let toolbar = toolbarOf(markup);

		expect(markup).toContain('data-document-expanded="true"');
		expect(toolbar).toContain("Room title");
		expect(markup.match(/<div[^>]*document-title-slot[^>]*>/)?.[0]).not.toContain("inert");
		expect(toolbar).toContain('aria-label="Show chat, Planner working"');
		expect(toolbar).toContain(">Chat</span>");
		expect(toolbar).not.toContain("Expand document");
		expect(toolbar.indexOf("Show chat")).toBeLessThan(toolbar.indexOf("Document controls"));
		expect(markup).not.toContain('aria-label="Resize chat"');
	});

	it("marks an in-app child push without discarding existing history state", () => {
		expect(childHistoryState({ navigation: 4 }, "/documents/octo-org/score/parent?view=plan#note"))
			.toEqual({
				navigation: 4,
				chopinChildParent: "/documents/octo-org/score/parent?view=plan#note",
			});
	});

	it("backs out of an in-app child but replaces a direct child with its parent", () => {
		let parent = "/documents/octo-org/score/parent";
		expect(childCloseAction(
			{ chopinChildParent: `${parent}?view=decisions#question` },
			parent,
		)).toEqual({ type: "back" });
		expect(childCloseAction(null, parent)).toEqual({
			type: "replace",
			destination: parent,
		});
	});

	it("keeps the child briefly only while returning to its own parent", () => {
		expect(childPresentation("open", "parent", true)).toBe("closing");
		expect(childPresentation("closing", "parent", true)).toBe("closing");
		expect(childPresentation("open", "parent", false)).toBe("closed");
		expect(childPresentation("closing", "child", true)).toBe("open");
		expect(childPresentation("open", "child", false)).toBe("closed");
	});

	it("builds a nested canonical path from both workspaces' current metadata", () => {
		expect(
			anchoredChildPaths(
				{ owner: "octo-org", repository: "score", slug: "renamed parent" },
				"renamed child",
			).child,
		).toBe(
			"/documents/octo-org/score/renamed%20parent/children/renamed%20child",
		);
	});

	it("rebases the marked parent after a rename without losing its search or hash", () => {
		expect(rebaseChildHistoryState(
			{ chopinChildParent: "/documents/octo-org/score/old?view=plan#note", navigation: 4 },
			"/documents/octo-org/score/new",
		)).toEqual({
			chopinChildParent: "/documents/octo-org/score/new?view=plan#note",
			navigation: 4,
		});
	});
});

describe("hosted login", () => {
	it("binds the current product location to the OAuth attempt", () => {
		expect(githubLoginHref("/documents/octo-org/score/release-plan", "?view=plan", "#item"))
			.toBe(
				"/auth/github?return_to=%2Fdocuments%2Focto-org%2Fscore%2Frelease-plan%3Fview%3Dplan%23item",
			);
		expect(githubLoginHref("/")).toBe("/auth/github?return_to=%2F");
	});
});

describe("channel recovery", () => {
	it("retries only failures a repeated channel read can recover from", () => {
		expect(retryableChannelFailure(new Error("network unavailable"))).toBe(true);
		expect(retryableChannelFailure(new ApiError("request timed out", 408))).toBe(true);
		expect(retryableChannelFailure(new ApiError("too many requests", 429))).toBe(true);
		expect(retryableChannelFailure(new ApiError("storage unavailable", 503))).toBe(true);
		expect(retryableChannelFailure(new ApiError("channel not found", 404))).toBe(false);
		expect(retryableChannelFailure(new ApiError("repository access is required", 403)))
			.toBe(false);
	});

	it("converges restored IDs and flat child slugs on the canonical child URL", async () => {
		let parent = detail("parent-one", "release-plan");
		let child = detail("child-one", "source-review", parent.channel.id);
		let readers = {
			async channel(id: string) {
				if (id === child.channel.id) return child;
				if (id === parent.channel.id) return parent;
				throw new ApiError("channel not found", 404);
			},
			async document(_owner: string, _repository: string, slug: string) {
				if (slug === child.channel.slug) return child;
				throw new ApiError("channel not found", 404);
			},
		};
		let signal = new AbortController().signal;

		expect(await prepareDocumentLoad({ id: child.channel.id }, signal, readers)).toEqual({
			detail: child,
			parent,
			pathname: "/documents/octo-org/score/release-plan/children/source-review",
		});
		expect(
			await prepareDocumentLoad(
				{
					owner: "octo-org",
					repository: "score",
					slug: child.channel.slug,
				},
				signal,
				readers,
			),
		).toEqual({
			detail: child,
			parent,
			pathname: "/documents/octo-org/score/release-plan/children/source-review",
		});
	});

	it("keeps top-level ID and slug loads on their ordinary canonical URL", async () => {
		let topLevel = detail("document-one", "release-plan");
		let readers = {
			async channel() {
				return topLevel;
			},
			async document() {
				return topLevel;
			},
		};
		let signal = new AbortController().signal;
		let expected = {
			detail: topLevel,
			pathname: "/documents/octo-org/score/release-plan",
		};

		expect(await prepareDocumentLoad({ id: topLevel.channel.id }, signal, readers))
			.toEqual(expected);
		expect(
			await prepareDocumentLoad(
				{
					owner: "octo-org",
					repository: "score",
					slug: topLevel.channel.slug,
				},
				signal,
				readers,
			),
		).toEqual(expected);
	});

	it("fails conservatively when authoritative parent resolution is missing or mismatched", async () => {
		let parent = detail("parent-one", "release-plan");
		let child = detail("child-one", "source-review", parent.channel.id);
		let signal = new AbortController().signal;
		let document = async () => child;

		await expect(prepareDocumentLoad(
			{ owner: "octo-org", repository: "score", slug: child.channel.slug },
			signal,
			{
				channel: async () => {
					throw new ApiError("channel not found", 404);
				},
				document,
			},
		)).rejects.toMatchObject({ status: 404 });
		await expect(prepareDocumentLoad(
			{ owner: "octo-org", repository: "score", slug: child.channel.slug },
			signal,
			{
				channel: async () => detail("different-parent", "release-plan"),
				document,
			},
		)).rejects.toMatchObject({ status: 404 });
	});

	it("aborts authoritative parent resolution for a stale document load", async () => {
		let parent = detail("parent-one", "release-plan");
		let child = detail("child-one", "source-review", parent.channel.id);
		let controller = new AbortController();
		let readers = {
			async channel(_id: string, signal?: AbortSignal): Promise<ChannelDetail> {
				if (signal?.aborted) throw new Error("stale load aborted");
				return new Promise((_resolve, reject) => {
					signal?.addEventListener("abort", () => reject(new Error("stale load aborted")));
				});
			},
			async document() {
				return child;
			},
		};
		let pending = prepareDocumentLoad(
			{ owner: "octo-org", repository: "score", slug: child.channel.slug },
			controller.signal,
			readers,
		);

		controller.abort();
		await expect(pending).rejects.toThrow("stale load aborted");
	});
});
