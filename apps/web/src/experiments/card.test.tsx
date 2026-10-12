import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { initialState } from "@chopin/experiment";
import { performance } from "../../../../packages/experiment/src/fixtures";
import type { PublishedInvestigation } from "@chopin/experiment/records";
import { InvestigationReference, removableInvestigation } from "./card";
import { ExperimentStore } from "./store";

function setup(state: PublishedInvestigation["state"]) {
	let store = new ExperimentStore("document");
	let item: PublishedInvestigation = {
		id: "investigation",
		documentId: "document",
		revision: 1,
		brief: "Compare startup approaches",
		requester: "ana",
		state,
		generation: 1,
		expiresAt: 0,
		createdAt: 0,
		updatedAt: 0,
		progress: "",
		views: {},
		decisions: [],
	};
	store.values.set(item.id, item);
	store.items = [{ ...item, decisionCount: 0 }];
	return { store, item };
}

function render(store: ExperimentStore, userId = "ana", locked = false) {
	return renderToStaticMarkup(createElement(InvestigationReference, {
		store,
		id: "investigation",
		userId,
		canEdit: true,
		locked,
		onRemove() {},
	}));
}

test("a requested investigation offers Run and can be withdrawn", () => {
	let { store } = setup("requested");
	let markup = render(store);
	expect(markup).toContain('aria-label="Investigation"');
	expect(markup).toContain("Ready to run");
	expect(markup).toMatch(/<button(?![^>]*disabled)[^>]*>Run<\/button>/);
	expect(markup).toContain('aria-label="Remove investigation"');
	// Its card goes only after the record is withdrawn.
	expect(removableInvestigation(store, "investigation")).toBe(false);
	expect(render(store, "ana", true)).toMatch(/<button[^>]*disabled=""[^>]*>Run<\/button>/);
});

test("only the person who ran it can stop running work, even under a build lock", () => {
	let { store, item } = setup("running");
	item.input = {
		id: item.id,
		documentId: item.documentId,
		brief: item.brief,
		context: "Document context",
		requester: "ana",
		authorizer: "ana",
		source: { repositoryId: "R_score", repository: "octo-org/score", commit: "a".repeat(40) },
	};
	expect(render(store, "ana", true)).toMatch(/<button(?![^>]*disabled)[^>]*>Stop<\/button>/);
	let peer = render(store, "leo", true);
	expect(peer).not.toContain(">Stop<");
	expect(peer).not.toContain("Remove investigation");
	expect(removableInvestigation(store, "investigation")).toBe(false);
});

test("settled work offers Retry", () => {
	for (let state of ["failed", "cancelled", "interrupted"] as const) {
		let { store } = setup(state);
		expect(render(store)).toMatch(/<button(?![^>]*disabled)[^>]*>Retry<\/button>/);
		expect(render(store)).toContain("Remove investigation");
		expect(removableInvestigation(store, "investigation")).toBe(true);
	}
});

test("a build lock preserves shared result selections while blocking document mutations", () => {
	let { store, item } = setup("completed");
	item.result = performance;
	item.views = Object.fromEntries(performance.views.map(view => [view.key, initialState(view)]));
	item.decisions = [{
		id: crypto.randomUUID(),
		view: performance.views[0]!.key,
		state: item.views[performance.views[0]!.key]!,
		conclusion: "Use cached startup",
		rationale: "Lower median",
		by: "leo",
		userId: "leo",
		at: 1,
	}];
	let markup = render(store, "ana", false);
	expect(markup).not.toContain("Remove investigation");
	expect(removableInvestigation(store, "investigation")).toBe(false);
	expect(markup).toContain("Use cached startup");
	expect(markup).toContain("Insert decision evidence in document");
	markup = render(store, "ana", true);
	expect(markup).not.toContain("Insert decision evidence in document");
	expect(markup.match(/<select[^>]*aria-label="Filter Workload"[^>]*>/)?.[0])
		.not.toContain("disabled");
	expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Record decision<\/button>/);
	expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Insert view in document<\/button>/);
});
