import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { pointAnchor, RepositoryLinksProvider, useLinkHref } from "./repository-links";

import type { LinkRepository } from "./repository-links";

const REPOSITORY: LinkRepository = { owner: "octo-org", name: "score", ref: "main" };

/** An anchor as Lexical leaves it: `href` already run through its own `sanitizeUrl`. */
function anchor(href: string) {
	let drawn = { href, writes: 0 };
	return {
		get href() {
			return drawn.href;
		},
		get writes() {
			return drawn.writes;
		},
		setAttribute(_name: "href", value: string) {
			drawn.href = value;
			drawn.writes++;
		},
	};
}

describe("an anchor for a link written as a repository path", () => {
	it("is pointed at the file on GitHub, replacing what Lexical made of the bare path", () => {
		let bare = anchor("https://docs/review.md");
		pointAnchor(bare, "docs/review.md", REPOSITORY);
		expect(bare.href).toBe("https://github.com/octo-org/score/blob/main/docs/review.md");

		let dotted = anchor("./docs/review.md");
		pointAnchor(dotted, "./docs/review.md#L10-L20", REPOSITORY);
		expect(dotted.href).toBe("https://github.com/octo-org/score/blob/main/docs/review.md#L10-L20");

		// Lexical reads an `@` as an email address.
		let scoped = anchor("mailto:packages/@scope/pkg/index.ts");
		pointAnchor(scoped, "packages/@scope/pkg/index.ts", REPOSITORY);
		expect(scoped.href).toBe(
			"https://github.com/octo-org/score/blob/main/packages/@scope/pkg/index.ts",
		);
	});

	it("is written once, however many updates reach it", () => {
		let link = anchor("https://docs/review.md");
		pointAnchor(link, "docs/review.md", REPOSITORY);
		pointAnchor(link, "docs/review.md", REPOSITORY);
		expect(link.writes).toBe(1);
	});

	it("keeps what Lexical drew for every other target", () => {
		for (
			let [drawn, target] of [
				["https://example.com/docs", "https://example.com/docs"],
				["mailto:ana@example.com", "mailto:ana@example.com"],
				["mailto:ana@example.com", "ana@example.com"],
				["http://localhost/#anchor", "#anchor"],
				["../secrets.md", "../secrets.md"],
				["//evil.example/a.md", "//evil.example/a.md"],
			] as const
		) {
			let link = anchor(drawn);
			pointAnchor(link, target, REPOSITORY);
			expect(link.href).toBe(drawn);
			expect(link.writes).toBe(0);
		}
	});
});

describe("a link drawn outside the editor", () => {
	function Link({ href }: { href: string }) {
		return <a href={useLinkHref(href)}>{href}</a>;
	}

	function drawn(href: string, repository?: LinkRepository): string {
		return renderToStaticMarkup(
			<RepositoryLinksProvider value={repository}>
				<Link href={href} />
			</RepositoryLinksProvider>,
		);
	}

	it("opens a repository path in the repository its host names", () => {
		expect(drawn("docs/review.md", REPOSITORY)).toContain(
			'href="https://github.com/octo-org/score/blob/main/docs/review.md"',
		);
		expect(drawn("docs/review.md", { owner: "octocat", name: "notes", ref: "trunk" })).toContain(
			'href="https://github.com/octocat/notes/blob/trunk/docs/review.md"',
		);
	});

	it("is left as written without a repository or for any other target", () => {
		expect(drawn("docs/review.md")).toContain('href="docs/review.md"');
		for (let href of ["https://example.com/a", "mailto:ana@example.com", "#a", "../a.md"]) {
			expect(drawn(href, REPOSITORY)).toContain(`href="${href}"`);
		}
	});
});
