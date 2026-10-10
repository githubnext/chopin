import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { initialState } from "@chopin/experiment";
import { performance } from "../../../../packages/experiment/src/fixtures";
import type { PublishedInvestigation } from "@chopin/experiment/records";
import { InvestigationCard } from "./card";
import { ExperimentStore } from "./store";

test("a build lock preserves shared result selections while blocking document mutations", () => {
	let store = new ExperimentStore("document");
	let item: PublishedInvestigation = {
		id: "investigation",
		documentId: "document",
		revision: 1,
		brief: "Compare startup approaches",
		requester: "ana",
		state: "completed",
		generation: 1,
		expiresAt: 0,
		createdAt: 0,
		updatedAt: 0,
		progress: "",
		result: performance,
		views: Object.fromEntries(performance.views.map(view => [view.key, initialState(view)])),
		decisions: [],
	};
	store.values.set(item.id, item);
	let markup = renderToStaticMarkup(createElement(InvestigationCard, {
		store,
		summary: { ...item, decisionCount: 0 },
		userId: "ana",
		canEdit: true,
		locked: true,
	}));
	expect(markup.match(/<select[^>]*aria-label="Filter Workload"[^>]*>/)?.[0])
		.not.toContain("disabled");
	expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Record decision<\/button>/);
	expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Insert view in document<\/button>/);
	item.state = "running";
	item.input = {
		id: item.id,
		documentId: item.documentId,
		brief: item.brief,
		context: "Document context",
		requester: "ana",
		authorizer: "ana",
		source: { repositoryId: "R_score", repository: "octo-org/score", commit: "a".repeat(40) },
	};
	markup = renderToStaticMarkup(createElement(InvestigationCard, {
		store,
		summary: { ...item, decisionCount: 0 },
		userId: "ana",
		canEdit: true,
		locked: true,
	}));
	expect(markup).toMatch(/<button(?![^>]*disabled)[^>]*>Cancel investigation<\/button>/);
	let peer = renderToStaticMarkup(createElement(InvestigationCard, {
		store,
		summary: { ...item, decisionCount: 0 },
		userId: "leo",
		canEdit: true,
		locked: true,
	}));
	expect(peer).not.toContain("Cancel investigation");
});
