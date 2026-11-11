import { describe, expect, test } from "bun:test";

import { linkAddress } from "./link-form";

describe("a link's address as it is typed", () => {
	test("puts https:// before a bare host, as Slack does", () => {
		expect(linkAddress(" example.test/plan ")).toBe("https://example.test/plan");
		expect(linkAddress("www.example.test")).toBe("https://www.example.test");
	});

	test("keeps an address that names its scheme, or is a place on this site, as typed", () => {
		expect(linkAddress("http://example.test")).toBe("http://example.test");
		expect(linkAddress("mailto:ana@example.test")).toBe("mailto:ana@example.test");
		expect(linkAddress("/docs/plan")).toBe("/docs/plan");
		expect(linkAddress("#overview")).toBe("#overview");
		expect(linkAddress("   ")).toBe("");
	});
});
