import { expect, test } from "bun:test";

import {
	decorate,
	endsWithNumber,
	fallbackLabel,
	pastedReference,
	pillName,
	pillState,
} from "./github-references";

import type { GitHubReferenceSummary } from "@chopin/protocol/github-reference";
import type { GitHubReferenceEntry, GitHubReferenceStore } from "./widget-options";

let base = {
	owner: "octo-org",
	repository: "score",
	number: 2,
	url: "https://github.com/octo-org/score/pull/2",
	title: "Render decision cards",
	author: null,
	labels: [],
	comments: 0,
	createdAt: "2026-09-01T12:00:00Z",
	updatedAt: "2026-09-01T12:00:00Z",
	closedAt: null,
};

function pull(state: "open" | "closed" | "merged", draft = false): GitHubReferenceEntry {
	let summary: GitHubReferenceSummary = {
		...base,
		kind: "pull",
		state,
		draft,
		mergedAt: null,
		headBranch: "topic",
		baseBranch: "main",
	};
	return { status: "ok", summary };
}

function issue(
	state: "open" | "closed",
	stateReason: "completed" | "not_planned" | null,
): GitHubReferenceEntry {
	return { status: "ok", summary: { ...base, kind: "issue", state, stateReason } };
}

test("every GitHub state maps to one pill state", () => {
	expect(pillState(pull("open"))).toBe("pr-open");
	expect(pillState(pull("open", true))).toBe("pr-draft");
	expect(pillState(pull("merged"))).toBe("pr-merged");
	expect(pillState(pull("closed"))).toBe("pr-closed");
	expect(pillState(issue("open", null))).toBe("issue-open");
	expect(pillState(issue("closed", "completed"))).toBe("issue-completed");
	expect(pillState(issue("closed", null))).toBe("issue-completed");
	expect(pillState(issue("closed", "not_planned"))).toBe("issue-not-planned");
	expect(pillState({ status: "loading" })).toBe("loading");
	expect(pillState({ status: "unavailable" })).toBe("unavailable");
	expect(pillState({ status: "rate-limited" })).toBe("unknown");
});

test("the number is drawn only when the authored text does not already end with it", () => {
	expect(endsWithNumber("octo-org/score#12", 12)).toBe(true);
	expect(endsWithNumber("Fix tables #12 ", 12)).toBe(true);
	expect(endsWithNumber("Fix tables #123", 12)).toBe(false);
	expect(endsWithNumber("Fix tables", 12)).toBe(false);
});

test("the accessible name says what, which and where it stands", () => {
	expect(pillName("pull", "Render decision cards", 2, "pr-merged"))
		.toBe("Pull request: Render decision cards #2, merged");
	expect(pillName("issue", "octo-org/score#7", 7, "issue-not-planned"))
		.toBe("Issue: octo-org/score#7, not planned");
	expect(pillName("pull", "acme/private#4", 4, "unavailable"))
		.toBe("Pull request: acme/private#4, no access");
});

test("a paste is a reference only when it is one bare GitHub URL", () => {
	let url = "https://github.com/octo-org/score/pull/2";
	expect(pastedReference(["text/plain"], ` ${url}\n`)).toEqual({
		url,
		reference: { owner: "octo-org", repository: "score", kind: "pull", number: 2 },
	});
	expect(pastedReference(["text/plain"], `see ${url}`)).toBeUndefined();
	expect(pastedReference(["text/plain"], "https://example.com/pull/2")).toBeUndefined();
	expect(pastedReference(["text/plain", "application/x-lexical-editor"], url)).toBeUndefined();
	expect(fallbackLabel({ owner: "octo-org", repository: "score", kind: "issue", number: 5 }))
		.toBe("octo-org/score#5");
});

/** Enough of an element for its decoration. */
function element() {
	return { ariaLabel: null as string | null, dataset: {} as Record<string, string> };
}

function store(entry: GitHubReferenceEntry): GitHubReferenceStore {
	return {
		get: () => entry,
		load: () => Promise.reject(new Error("unused")),
		subscribe: () => () => {},
	};
}

test("decoration marks a reference link and clears itself when the URL stops being one", () => {
	let link = element();
	let el = link as unknown as HTMLElement;
	decorate(el, base.url, "Render decision cards", false, store(pull("merged")));
	expect(link.dataset).toEqual({ ghKind: "pull", ghState: "pr-merged", ghNumber: "#2" });
	expect(link.ariaLabel).toBe("Pull request: Render decision cards #2, merged");

	decorate(el, base.url, "octo-org/score#2", true, store(pull("merged")));
	expect(link.dataset.ghNumber).toBeUndefined();
	expect(link.dataset.ghEditing).toBe("");

	decorate(el, "https://example.com", "Elsewhere", false, store(pull("merged")));
	expect(link.dataset).toEqual({});
	expect(link.ariaLabel).toBeNull();
});

test("the kind GitHub reports wins over the URL's", () => {
	let link = element();
	decorate(
		link as unknown as HTMLElement,
		"https://github.com/octo-org/score/pull/2",
		"Render decision cards",
		false,
		store(issue("open", null)),
	);
	expect(link.dataset.ghKind).toBe("issue");
	expect(link.dataset.ghState).toBe("issue-open");
});
