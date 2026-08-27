import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ApiError } from "./api";
import {
	anchoredChildPaths,
	AnchoredChildSurface,
	childCloseAction,
	childHistoryState,
	childPresentation,
	rebaseChildHistoryState,
} from "./anchored-child-surface";
import { githubLoginHref, hostedRoute, retryableChannelFailure } from "./hosted";
import { prepareDocumentLoad, validatedChildPath } from "./document-loader";

import type { ChannelDetail } from "./api";

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

describe("hosted routes", () => {
	it("recognizes canonical document and legacy routes", () => {
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
		)).toEqual({
			page: "research",
			owner: "octo-org",
			repository: "score",
			slug: "résumé-計画",
			workspaceId: "workspace:1",
		});
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
	it("renders one parent-aware close control over an inert parent with separate rooms", () => {
		let markup = renderToStaticMarkup(createElement(AnchoredChildSurface, {
			child: createElement("div", { "data-workspace-room": "child-room" }),
			childLabel: "Source review",
			onClose() {},
			parent: createElement("div", { "data-workspace-room": "parent-room" }),
			parentLabel: "Release plan",
			presentation: "open",
		}));

		expect(markup).toContain('aria-hidden="true"');
		expect(markup).toContain('inert=""');
		expect(markup).toContain('aria-label="Back to Release plan"');
		expect(markup.match(/<button/g)).toHaveLength(1);
		expect(markup).toContain('data-workspace-room="parent-room"');
		expect(markup).toContain('data-workspace-room="child-room"');
		expect(markup).not.toContain("Expand");
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
