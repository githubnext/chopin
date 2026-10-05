import { describe, expect, it } from "bun:test";

import { IMAGE_PROTOCOLS, LINK_PROTOCOLS } from "@chopin/dialect";

import { checkUrl } from "./url";

const LINKS = { protocols: LINK_PROTOCOLS, relative: true };
const IMAGES = { protocols: IMAGE_PROTOCOLS, relative: false };

describe("checking a link before it becomes a node", () => {
	it("keeps an allowed absolute URL as typed, trimmed", () => {
		expect(checkUrl("  https://example.com/a?b#c ", LINKS)).toEqual({
			url: "https://example.com/a?b#c",
		});
		expect(checkUrl("mailto:ana@example.com", LINKS)).toEqual({ url: "mailto:ana@example.com" });
	});

	it("gives a bare domain the https it was meant to have", () => {
		expect(checkUrl("example.com", LINKS)).toEqual({ url: "https://example.com" });
		expect(checkUrl("www.example.co.uk/path?q=1", LINKS)).toEqual({
			url: "https://www.example.co.uk/path?q=1",
		});
	});

	it("turns a bare address into a mailto link", () => {
		expect(checkUrl("ana@example.com", LINKS)).toEqual({ url: "mailto:ana@example.com" });
	});

	/** A repository file looks like a domain to a careless pattern. */
	it("leaves repository paths relative", () => {
		expect(checkUrl("README.md", LINKS)).toEqual({ url: "README.md" });
		expect(checkUrl("docs/architecture.md", LINKS)).toEqual({ url: "docs/architecture.md" });
		expect(checkUrl("./notes.mdx#intro", LINKS)).toEqual({ url: "./notes.mdx#intro" });
		expect(checkUrl("#decisions", LINKS)).toEqual({ url: "#decisions" });
	});

	it("refuses a scheme the dialect will not carry", () => {
		let refused = checkUrl("javascript:alert(1)", LINKS);
		expect(refused.url).toBeUndefined();
		expect(refused.problem).toBe("Use an https:// or mailto: link, or a path in this repository.");
		expect(checkUrl("http://example.com", LINKS).problem).toBeDefined();
	});

	it("says what is wrong with an empty or spaced value", () => {
		expect(checkUrl("   ", LINKS)).toEqual({ problem: "Enter a URL." });
		expect(checkUrl("my notes.md", LINKS)).toEqual({ problem: "A URL cannot contain spaces." });
	});

	it("never makes an image relative", () => {
		expect(checkUrl("images/a.png", IMAGES)).toEqual({ problem: "Use an https:// address." });
		expect(checkUrl("example.com/a.png", IMAGES)).toEqual({ url: "https://example.com/a.png" });
		expect(checkUrl("ana@example.com", IMAGES).problem).toBeDefined();
	});
});
