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
		onOpen() {},
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

test("a completed investigation is a compact card that opens its child document", () => {
	let { store, item } = setup("completed");
	item.result = performance;
	item.views = Object.fromEntries(performance.views.map(view => [view.key, initialState(view)]));
	item.child = {
		id: "child",
		title: "Startup comparison",
		slug: "startup-comparison",
		summary: "Caching reduced median startup time.",
	};
	let markup = render(store);
	expect(markup).toContain("Startup comparison");
	expect(markup).toContain("Caching reduced median startup time.");
	expect(markup).toContain("1 view");
	expect(markup).toContain('data-investigation="investigation"');
	expect(markup).toContain('aria-label="Open Startup comparison"');
	expect(markup).not.toContain("Compare startup approaches");
	expect(markup).not.toContain("<select");
	expect(markup).not.toContain("Remove investigation");
	expect(removableInvestigation(store, "investigation")).toBe(false);
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
	// Decisions recorded in the child stay reachable from the card that links it.
	markup = render(store);
	expect(markup).toContain("Use cached startup");
	expect(markup).toContain("Insert decision evidence in document");
	expect(render(store, "ana", true)).not.toContain("Insert decision evidence in document");
});

test("a completed investigation whose child is gone says so", () => {
	let { store, item } = setup("completed");
	item.result = performance;
	let markup = render(store);
	expect(markup).toContain("Its published document is no longer available.");
	expect(markup).not.toContain("Open ");
});
