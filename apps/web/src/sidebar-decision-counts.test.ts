import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { unansweredDecisionsLabel } from "./decision-view-control";
import {
	acceptDecisionCounts,
	applyDecisionCounts,
	applyDecisionSnapshot,
	beginDocumentLoad,
	completeDocumentPage,
	failDocumentLoad,
	MAX_WATCHED_DOCUMENTS,
	MAX_WATCHED_REPOSITORIES,
	newestDocument,
	projectDocuments,
	removeLoadedDocument,
	replaceProjectTotal,
	staleDecisionCounts,
	watchedRepositories,
} from "./document-actions";
import { ProjectSidebar } from "./project-sidebar";

import type { ComponentProps } from "react";
import type * as Api from "./api";
import type { DocumentLoadState } from "./document-actions";

let parent: Api.Channel = {
	id: "channel-lease",
	repositoryId: "R_chopin",
	repositoryOwner: "githubnext",
	repositoryName: "chopin",
	title: "Postgres writer lease",
	slug: "postgres-writer-lease",
	createdBy: "user-one",
	revision: 3,
	createdAt: "2026-08-20T00:00:00.000Z",
	updatedAt: "2026-08-23T00:00:00.000Z",
	descriptionRevision: 0,
	unansweredDecisions: 4,
};

let child: Api.Channel = {
	...parent,
	id: "channel-fencing",
	parentChannelId: parent.id,
	title: "Fencing tokens",
	slug: "fencing-tokens",
	unansweredDecisions: 1,
};

let quiet: Api.Channel = {
	...parent,
	id: "channel-quiet",
	title: "Settled plan",
	slug: "settled-plan",
	unansweredDecisions: 0,
};

function sidebar(
	documents: DocumentLoadState,
	overrides: Partial<ComponentProps<typeof ProjectSidebar>> = {},
): string {
	return renderToStaticMarkup(createElement(ProjectSidebar, {
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
			documents,
			project: {
				available: true,
				position: 0,
				repositoryId: "R_chopin",
				repositoryName: "chopin",
				repositoryOwner: "githubnext",
				repository: {
					id: "R_chopin",
					owner: "githubnext",
					name: "chopin",
					fullName: "githubnext/chopin",
					permissions: { pull: true, push: true, admin: false },
				},
			},
		}],
		catalogueMode: "active",
		user: { avatarUrl: "", id: "user-one", login: "octocat" },
		...overrides,
	}));
}

function counts(markup: string): string[] {
	return [...markup.matchAll(/data-sidebar-decision-count=""><span[^>]*>(\d+)<\/span>/g)]
		.map(match => match[1]!);
}

describe("unanswered decision labels", () => {
	it("follows the Decisions tab wording and leaves zero unlabelled", () => {
		expect(unansweredDecisionsLabel("Postgres writer lease", 4))
			.toBe("Postgres writer lease, 4 unanswered decisions");
		expect(unansweredDecisionsLabel("chopin", 1)).toBe("chopin, 1 unanswered decision");
		expect(unansweredDecisionsLabel("Settled plan", 0)).toBe("Settled plan");
	});
});

describe("sidebar decision counts", () => {
	let loaded: DocumentLoadState = {
		status: "ready",
		channels: [parent, child, quiet],
		nextCursor: "later-page",
		unansweredDecisions: 10,
	};

	it("labels document, child, and project rows with their unanswered counts", () => {
		let markup = sidebar(loaded);

		expect(markup).toContain('aria-label="Postgres writer lease, 4 unanswered decisions"');
		expect(markup).toContain('aria-label="Fencing tokens, 1 unanswered decision"');
		expect(markup).toMatch(
			/<button[^>]*aria-expanded="true"[^>]*aria-label="chopin, 10 unanswered decisions"[^>]*class="project-sidebar-project-disclosure/,
		);
		expect(counts(markup)).toEqual(["10", "4", "1"]);
	});

	it("shows the server's project total rather than the loaded rows' sum", () => {
		let markup = sidebar(loaded);

		expect(markup).toContain("chopin, 10 unanswered decisions");
		expect(markup).not.toContain("chopin, 5 unanswered");
	});

	it("shows the project total before any of its rows load", () => {
		let markup = sidebar({ ...loaded, channels: [] });

		expect(markup).toContain("chopin, 10 unanswered decisions");
		expect(counts(markup)).toEqual(["10"]);
	});

	it("hides counts from accessible names and renders the shared quiet Count", () => {
		let markup = sidebar(loaded);
		let slots = [...markup.matchAll(/<span([^>]*)data-sidebar-decision-count="">(<span[^>]*>)/g)];

		expect(slots).toHaveLength(3);
		for (let [, attributes, count] of slots) {
			expect(attributes).toContain('aria-hidden="true"');
			expect(attributes).toContain('class="project-sidebar-count"');
			expect(count).toContain("bg-inset");
			expect(count).toContain("text-text-tertiary");
			expect(count).not.toContain("bg-brand");
		}
	});

	it("places each count after the row action in one trailing slot", () => {
		let markup = sidebar(loaded);

		expect(markup).toMatch(
			/aria-label="New document in chopin"[^>]*>.*?<\/button><span aria-hidden="true" class="project-sidebar-count"/s,
		);
		expect(markup).toMatch(
			/aria-label="Actions for Postgres writer lease".*?<\/div><span aria-hidden="true" class="project-sidebar-count"/s,
		);
		expect(markup).toMatch(
			/aria-label="Actions for Fencing tokens".*?<\/div><span aria-hidden="true" class="project-sidebar-count"/s,
		);
	});

	it("shows nothing for zero", () => {
		let markup = sidebar({
			status: "ready",
			channels: [quiet],
			unansweredDecisions: 0,
		});

		expect(counts(markup)).toEqual([]);
		expect(markup).not.toContain("unanswered");
		expect(markup).toContain(
			'<a class="project-sidebar-document-link" data-tooltip-side="right" data-tooltip-verbatim="" href="/documents/githubnext/chopin/settled-plan">',
		);
	});

	it("keeps archived catalogue rows free of counts", () => {
		let archived = { ...parent, archivedAt: "2026-08-24T00:00:00.000Z" };
		let markup = sidebar({ ...loaded, channels: [archived] }, { catalogueMode: "archived" });

		expect(counts(markup)).toEqual([]);
		expect(markup).not.toContain("unanswered");
	});
});

describe("catalogue decision totals", () => {
	it("keeps the server total across loading, failure, and pages without one", () => {
		let first = completeDocumentPage(beginDocumentLoad(), [parent], "next", true, undefined, 7);
		expect(first.unansweredDecisions).toBe(7);
		expect(beginDocumentLoad(first).unansweredDecisions).toBe(7);
		expect(failDocumentLoad(first, new Error("offline")).unansweredDecisions).toBe(7);
		expect(completeDocumentPage(first, [child]).unansweredDecisions).toBe(7);
		expect(completeDocumentPage(first, [child], undefined, false, undefined, 3).unansweredDecisions)
			.toBe(3);
	});

	it("applies a committed count to its row and project total", () => {
		let documents = {
			R_chopin: { status: "ready" as const, channels: [parent, child], unansweredDecisions: 10 },
		};
		let next = applyDecisionCounts(documents, {
			channelId: child.id,
			repositoryId: "R_chopin",
			unanswered: 0,
			repositoryUnanswered: 9,
			revision: 4,
		});

		expect(next.R_chopin!.unansweredDecisions).toBe(9);
		expect(next.R_chopin!.channels.map(channel => channel.unansweredDecisions)).toEqual([4, 0]);
		expect(next.R_chopin!.channels[1]!.revision).toBe(4);
		expect(next.R_chopin!.channels[0]).toBe(parent);
	});

	it("never lets an older commit's count or total replace a newer one", () => {
		let documents = {
			R_chopin: { status: "ready" as const, channels: [parent], unansweredDecisions: 10 },
		};
		let stale = {
			channelId: parent.id,
			repositoryId: "R_chopin",
			unanswered: 7,
			repositoryUnanswered: 13,
			revision: 2,
		};
		expect(applyDecisionCounts(documents, stale)).toBe(documents);
		expect(staleDecisionCounts(parent, stale)).toBe(true);
		expect(staleDecisionCounts(parent, { ...stale, revision: 3 })).toBe(false);
		expect(staleDecisionCounts(undefined, stale)).toBe(false);

		let asked = applyDecisionCounts(documents, {
			...stale,
			unanswered: 5,
			repositoryUnanswered: 11,
			revision: 4,
		});
		let openedEarlier = applyDecisionCounts(asked, {
			...stale,
			unanswered: 4,
			repositoryUnanswered: 10,
			revision: 3,
		});
		expect(openedEarlier).toBe(asked);
		expect(openedEarlier.R_chopin).toMatchObject({ unansweredDecisions: 11 });
		expect(openedEarlier.R_chopin!.channels[0]).toMatchObject({
			revision: 4,
			unansweredDecisions: 5,
		});
		expect(acceptDecisionCounts(parent, undefined)).toBe(parent);
		expect(acceptDecisionCounts(parent, {
			channelId: child.id,
			repositoryId: "R_chopin",
			unanswered: 0,
			repositoryUnanswered: 0,
			revision: 9,
		})).toBe(parent);

		let committed = { ...parent, revision: 5, unansweredDecisions: 3 };
		let listedEarlier = { ...parent, revision: 3, unansweredDecisions: 4 };
		expect(newestDocument(committed, listedEarlier)).toMatchObject({
			revision: 5,
			unansweredDecisions: 3,
		});
		expect(newestDocument(listedEarlier, committed)).toMatchObject({
			revision: 5,
			unansweredDecisions: 3,
		});
	});

	it("updates an unloaded document's project total and ignores unchanged counts", () => {
		let documents = {
			R_chopin: { status: "ready" as const, channels: [parent], unansweredDecisions: 10 },
		};
		let unloaded = applyDecisionCounts(documents, {
			channelId: "channel-on-a-later-page",
			repositoryId: "R_chopin",
			unanswered: 2,
			repositoryUnanswered: 12,
			revision: 1,
		});

		expect(unloaded.R_chopin!.unansweredDecisions).toBe(12);
		expect(unloaded.R_chopin!.channels).toBe(documents.R_chopin.channels);
		expect(applyDecisionCounts(unloaded, {
			channelId: parent.id,
			repositoryId: "R_chopin",
			unanswered: 4,
			repositoryUnanswered: 12,
			revision: 3,
		})).toBe(unloaded);
		expect(applyDecisionCounts(unloaded, {
			channelId: parent.id,
			repositoryId: "R_other",
			unanswered: 1,
			repositoryUnanswered: 1,
			revision: 9,
		})).toBe(unloaded);
	});

	it("replaces the project total once an archived document leaves its rows", () => {
		let documents = {
			R_chopin: { status: "ready" as const, channels: [parent, child], unansweredDecisions: 5 },
		};
		let removed = removeLoadedDocument(documents, parent.id);
		expect(removed.R_chopin).toMatchObject({ unansweredDecisions: 5 });
		let archived = replaceProjectTotal(removed, "R_chopin", 0);

		expect(archived.R_chopin).toMatchObject({ unansweredDecisions: 0 });
		expect(sidebar(archived.R_chopin!)).not.toContain("unanswered decision");
		expect(replaceProjectTotal(archived, "R_chopin", 0)).toBe(archived);
		expect(replaceProjectTotal(archived, "R_other", 4)).toBe(archived);
	});
});

function navigationProject(index: number, available: boolean): Api.NavigationProject {
	return {
		available,
		position: index,
		repositoryId: `R_${index}`,
		repositoryName: `repository-${index}`,
		repositoryOwner: "octo-org",
	};
}

describe("decision count catch-up", () => {
	it("reconciles every loaded row and the project total missed while disconnected", () => {
		let documents = {
			R_chopin: {
				status: "ready" as const,
				channels: [parent, child, quiet],
				unansweredDecisions: 10,
			},
		};
		let next = applyDecisionSnapshot(documents, {
			repositoryId: "R_chopin",
			repositoryUnanswered: 8,
			documents: [
				{ channelId: parent.id, unanswered: 2, revision: 5 },
				{ channelId: child.id, unanswered: 1, revision: 3 },
				{ channelId: quiet.id, unanswered: 1, revision: 4 },
			],
		});

		expect(next.R_chopin!.unansweredDecisions).toBe(8);
		expect(next.R_chopin!.channels.map(channel => channel.unansweredDecisions)).toEqual([2, 1, 1]);
		expect(next.R_chopin!.channels[1]).toBe(child);
		expect(counts(sidebar(next.R_chopin!))).toEqual(["8", "2", "1", "1"]);
	});

	it("keeps newer row counts and leaves other repositories alone", () => {
		let documents = {
			R_chopin: { status: "ready" as const, channels: [parent], unansweredDecisions: 4 },
		};
		let snapshot = {
			repositoryId: "R_chopin",
			repositoryUnanswered: 4,
			documents: [{ channelId: parent.id, unanswered: 9, revision: 2 }],
		};
		expect(applyDecisionSnapshot(documents, snapshot)).toBe(documents);
		expect(applyDecisionSnapshot(documents, { ...snapshot, repositoryId: "R_other" })).toBe(
			documents,
		);
		let total = applyDecisionSnapshot(documents, { ...snapshot, repositoryUnanswered: 6 });
		expect(total.R_chopin).toMatchObject({ unansweredDecisions: 6 });
		expect(total.R_chopin!.channels[0]).toBe(parent);
	});

	it("watches every available sidebar project with its loaded documents, within bounds", () => {
		let projects = Array.from(
			{ length: MAX_WATCHED_REPOSITORIES + 2 },
			(_, index) => navigationProject(index, index !== 1),
		);
		let many = Array.from(
			{ length: MAX_WATCHED_DOCUMENTS + 1 },
			(_, index) => ({ ...parent, id: `channel-${index}` }),
		);
		let watched = watchedRepositories(projectDocuments({ projects }, {
			R_0: { status: "ready", channels: [parent, child] },
			R_2: { status: "loading", channels: many },
		}));

		expect(watched).toHaveLength(MAX_WATCHED_REPOSITORIES);
		expect(watched[0]).toEqual({
			repositoryId: "R_0",
			owner: "octo-org",
			name: "repository-0",
			channelIds: [parent.id, child.id],
		});
		expect(watched.some(repository => repository.repositoryId === "R_1")).toBe(false);
		expect(watched[1]!.channelIds).toHaveLength(MAX_WATCHED_DOCUMENTS);
		expect(watched[2]!.channelIds).toEqual([]);
	});
});
