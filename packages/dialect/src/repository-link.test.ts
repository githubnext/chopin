import { describe, expect, it } from "bun:test";

import { disguisedUrl } from "./dialect";
import { repositoryLinkUrl } from "./repository-link";

const REPOSITORY = { owner: "octo-org", name: "score", ref: "main" };
const BLOB = "https://github.com/octo-org/score/blob/main/";

describe("repositoryLinkUrl", () => {
	it("opens a path in the repository as the file on GitHub", () => {
		expect(repositoryLinkUrl("docs/review.md", REPOSITORY)).toBe(`${BLOB}docs/review.md`);
		expect(repositoryLinkUrl("./docs/review.md", REPOSITORY)).toBe(`${BLOB}docs/review.md`);
		expect(repositoryLinkUrl("README.md", REPOSITORY)).toBe(`${BLOB}README.md`);
		expect(repositoryLinkUrl(".github/workflows/ci.yml", REPOSITORY))
			.toBe(`${BLOB}.github/workflows/ci.yml`);
	});

	it("keeps a line range, query and anchor with the file", () => {
		expect(repositoryLinkUrl("docs/review.md#L10-L20", REPOSITORY))
			.toBe(`${BLOB}docs/review.md#L10-L20`);
		expect(repositoryLinkUrl("./src/app.ts?plain=1#L3", REPOSITORY))
			.toBe(`${BLOB}src/app.ts?plain=1#L3`);
	});

	it("opens at the ref it is given, wherever that ref has slashes or odd characters", () => {
		expect(repositoryLinkUrl("docs/review.md", { ...REPOSITORY, ref: "release/1.0" }))
			.toBe("https://github.com/octo-org/score/blob/release/1.0/docs/review.md");
		expect(repositoryLinkUrl("docs/review.md", { ...REPOSITORY, ref: "fix#12" }))
			.toBe("https://github.com/octo-org/score/blob/fix%2312/docs/review.md");
		expect(repositoryLinkUrl("docs/review.md", { owner: "octocat", name: "notes", ref: "trunk" }))
			.toBe("https://github.com/octocat/notes/blob/trunk/docs/review.md");
	});

	it("leaves the characters of a path as written, escaping only what a URL cannot hold", () => {
		expect(repositoryLinkUrl("docs/my file.md", REPOSITORY)).toBe(`${BLOB}docs/my%20file.md`);
		expect(repositoryLinkUrl("docs/my%20file.md", REPOSITORY)).toBe(`${BLOB}docs/my%20file.md`);
		expect(repositoryLinkUrl("packages/@scope/pkg/index.ts", REPOSITORY))
			.toBe(`${BLOB}packages/@scope/pkg/index.ts`);
		expect(repositoryLinkUrl("assets/logo@2x.png", REPOSITORY)).toBe(`${BLOB}assets/logo@2x.png`);
	});

	it("settles dot segments that stay inside the repository", () => {
		expect(repositoryLinkUrl("docs/../README.md", REPOSITORY)).toBe(`${BLOB}README.md`);
		expect(repositoryLinkUrl("./docs/./api/../review.md", REPOSITORY))
			.toBe(`${BLOB}docs/review.md`);
	});

	it("does not touch a target that is not a path in the repository", () => {
		for (
			let target of [
				"https://example.com/docs/review.md",
				"https://github.com/other/repo/blob/main/a.md",
				"http://example.com",
				"mailto:ana@example.com",
				"javascript:alert(1)",
				"tel:5551234",
				"#anchor",
				"?plain=1",
				// Chopin's own paths, such as a link to another document, stay where they are.
				"/documents/octo-org/score/other-document",
				"/docs/review.md",
				"",
				"ana@example.com",
			]
		) {
			expect(repositoryLinkUrl(target, REPOSITORY)).toBeUndefined();
		}
	});

	it("stays refused for a path that leaves the repository", () => {
		for (
			let target of [
				"../secrets.md",
				"docs/../../secrets.md",
				"./../secrets.md",
				"%2e%2e/secrets.md",
				"docs/%2e%2e/%2e%2e/secrets.md",
				// Back down into the same ref is still a way out of the root, and so refused.
				"../main/secrets.md",
				".%2E/secrets.md",
				"../../../other/repo/blob/main/a.md",
				"//evil.example/a.md",
				"/\\evil.example/a.md",
				"docs\\review.md",
			]
		) {
			expect(repositoryLinkUrl(target, REPOSITORY)).toBeUndefined();
		}
		// A ref with slashes is climbed out of the same way.
		expect(repositoryLinkUrl("../review.md", { ...REPOSITORY, ref: "release/1.0" }))
			.toBeUndefined();
	});

	it("stays refused for a path the dialect refuses to store", () => {
		for (
			let target of [
				` docs/review.md`,
				`docs/review.md `,
				`docs/${String.fromCharCode(0x202e)}gpj.md`,
				`docs/re${String.fromCharCode(0x200b)}view.md`,
				"java\tscript:alert(1)",
				"../secret.md",
				"docs/../../secret.md",
				"docs/%2e%2e/%2e%2e/secret.md",
			]
		) {
			expect(disguisedUrl(target)).toBeDefined();
			expect(repositoryLinkUrl(target, REPOSITORY)).toBeUndefined();
		}
	});

	it("lets a dot segment that stays inside the repository be stored and opened", () => {
		expect(disguisedUrl("docs/../README.md")).toBeUndefined();
		expect(repositoryLinkUrl("docs/../README.md", REPOSITORY)).toMatch(/\/blob\/.+\/README\.md$/);
	});
});
