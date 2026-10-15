import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { DocumentSearchResults } from "./document-search-dialog";

import type { DocumentSearchState } from "./document-search-dialog";

function render(search: DocumentSearchState, query = "") {
	return renderToStaticMarkup(createElement(DocumentSearchResults, {
		input: { current: null },
		manyProjects: false,
		onChoose() {},
		onRetry() {},
		query,
		search,
	}));
}

describe("document search results", () => {
	test("distinguish an empty catalogue from an unmatched query", () => {
		let ready: DocumentSearchState = { failedProjectIds: [], results: [], status: "ready" };

		expect(render(ready)).toContain("No documents yet");
		expect(render(ready, "typography")).toContain("No matching documents");
	});

	test("show loading and a retryable error", () => {
		expect(render({ status: "loading" })).toContain('aria-busy="true"');
		let error = render({ message: "Search failed.", status: "error" });
		expect(error).toContain('role="alert">Search failed.</p>');
		expect(error).toContain("Try again");
	});
});
