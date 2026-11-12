import { describe, expect, it } from "bun:test";

import { appLink } from "./app-links";

let here = new URL("https://chopin.test/documents/octo-org/score/rollout#overview");

describe("where a link goes inside the app", () => {
	it("is a section of the page on show for its hash, written alone or on the page's own address", () => {
		expect(appLink("#whats-new", here)).toEqual({ kind: "section", hash: "#whats-new" });
		expect(appLink("https://chopin.test/documents/octo-org/score/rollout#notes-1", here))
			.toEqual({ kind: "section", hash: "#notes-1" });
	});

	it("is another page for another document, keeping the section it names", () => {
		expect(appLink("/documents/octo-org/score/elsewhere#deep", here))
			.toEqual({ kind: "page", path: "/documents/octo-org/score/elsewhere#deep" });
		// The page's own address with no hash, or another query, is a visit rather than a jump.
		expect(appLink("/documents/octo-org/score/rollout", here))
			.toEqual({ kind: "page", path: "/documents/octo-org/score/rollout" });
		expect(appLink("/documents/octo-org/score/rollout?view=decisions#a", here))
			.toEqual({ kind: "page", path: "/documents/octo-org/score/rollout?view=decisions#a" });
	});

	it("is nothing for another site or a path the server answers", () => {
		expect(appLink("https://example.com/documents/a/b/c#x", here)).toBeUndefined();
		expect(appLink("mailto:ana@example.com", here)).toBeUndefined();
		expect(appLink("/auth/github/install", here)).toBeUndefined();
		expect(appLink("/images/abc.png", here)).toBeUndefined();
	});
});
