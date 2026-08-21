import { describe, expect, it } from "bun:test";

import { documentPath, documentsPath, parseDocumentPath } from "@chopin/protocol/document-url";

describe("document paths", () => {
	it("builds and parses canonical collection and document paths", () => {
		expect(documentsPath("octo-org", "score")).toBe("/documents/octo-org/score");
		expect(documentPath("octo-org", "score", "release-plan")).toBe(
			"/documents/octo-org/score/release-plan",
		);
		expect(parseDocumentPath("/documents/octo-org/score")).toEqual({
			owner: "octo-org",
			repository: "score",
		});
		expect(parseDocumentPath("/documents/octo-org/score/release-plan")).toEqual({
			owner: "octo-org",
			repository: "score",
			slug: "release-plan",
		});
	});

	it("encodes and decodes each Unicode and reserved-character segment", () => {
		let path = documentPath("München org", "計画/roadmap", "café?#100%");
		expect(path).toBe(
			"/documents/M%C3%BCnchen%20org/%E8%A8%88%E7%94%BB%2Froadmap/caf%C3%A9%3F%23100%25",
		);
		expect(parseDocumentPath(path)).toEqual({
			owner: "München org",
			repository: "計画/roadmap",
			slug: "café?#100%",
		});
	});

	it("accepts one optional trailing slash", () => {
		expect(parseDocumentPath("/documents/octo-org/score/")).toEqual({
			owner: "octo-org",
			repository: "score",
		});
		expect(parseDocumentPath("/documents/octo-org/score/release-plan/")).toEqual({
			owner: "octo-org",
			repository: "score",
			slug: "release-plan",
		});
	});

	it("rejects malformed percent encoding", () => {
		for (
			let path of [
				"/documents/%/score",
				"/documents/octo-org/%E0%A4%A",
				"/documents/octo-org/score/%C0%AF",
			]
		) {
			expect(parseDocumentPath(path)).toBeUndefined();
		}
	});

	it("rejects missing, empty and extra segments", () => {
		for (
			let path of [
				"/documents",
				"/documents/octo-org",
				"/documents//score",
				"/documents/octo-org//release-plan",
				"/documents/octo-org/score/release-plan/extra",
				"/documents/octo-org/score//",
			]
		) {
			expect(parseDocumentPath(path)).toBeUndefined();
		}
		expect(() => documentsPath("", "score")).toThrow(TypeError);
		expect(() => documentPath("octo-org", "score", "")).toThrow(TypeError);
	});

	it("does not parse legacy routes", () => {
		expect(parseDocumentPath("/repositories/octo-org/score")).toBeUndefined();
		expect(parseDocumentPath("/channels/019c1234-1234-5123-8123-123456789abc"))
			.toBeUndefined();
	});
});
