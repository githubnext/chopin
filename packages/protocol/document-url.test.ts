import { describe, expect, it } from "bun:test";

import {
	childDocumentPath,
	documentPath,
	documentsPath,
	parseChildDocumentPath,
	parseDocumentPath,
	parseResearchWorkspacePath,
	researchWorkspacePath,
} from "@chopin/protocol/document-url";

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

describe("child document paths", () => {
	it("builds and parses the canonical nested route", () => {
		let path = childDocumentPath("octo-org", "score", "release-plan", "source-review");
		expect(path).toBe(
			"/documents/octo-org/score/release-plan/children/source-review",
		);
		expect(parseChildDocumentPath(path)).toEqual({
			owner: "octo-org",
			repository: "score",
			parentSlug: "release-plan",
			childSlug: "source-review",
		});
		expect(parseDocumentPath(path)).toBeUndefined();
	});

	it("encodes and decodes every nested route segment", () => {
		let path = childDocumentPath(
			"München/org",
			"計画 roadmap",
			"café?#100%",
			"研究/report ?#%",
		);
		expect(path).toBe(
			"/documents/M%C3%BCnchen%2Forg/%E8%A8%88%E7%94%BB%20roadmap/caf%C3%A9%3F%23100%25/children/%E7%A0%94%E7%A9%B6%2Freport%20%3F%23%25",
		);
		expect(parseChildDocumentPath(path)).toEqual({
			owner: "München/org",
			repository: "計画 roadmap",
			parentSlug: "café?#100%",
			childSlug: "研究/report ?#%",
		});
	});

	it("accepts one trailing slash and rejects malformed nested routes", () => {
		expect(
			parseChildDocumentPath(
				"/documents/octo-org/score/release-plan/children/source-review/",
			),
		).toEqual({
			owner: "octo-org",
			repository: "score",
			parentSlug: "release-plan",
			childSlug: "source-review",
		});
		for (
			let path of [
				"/documents/octo-org/score/release-plan/children/source-review//",
				"/documents/%/score/release-plan/children/source-review",
				"/documents/octo-org/%E0%A4%A/release-plan/children/source-review",
				"/documents/octo-org/score/%C0%AF/children/source-review",
				"/documents/octo-org/score/release-plan/children/%ZZ",
				"/documents/octo-org/score/release-plan/children",
				"/documents/octo-org/score/release-plan/children/",
				"/documents/octo-org/score/release-plan/Children/source-review",
				"/documents/octo-org/score/release-plan/children/source-review/extra",
				"/documents/octo-org/score/release-plan/children/source-review?view=all",
				"documents/octo-org/score/release-plan/children/source-review",
			]
		) {
			expect(parseChildDocumentPath(path)).toBeUndefined();
		}
	});

	it("rejects empty nested route helper segments", () => {
		for (
			let segments of [
				["", "score", "release-plan", "source-review"],
				["octo-org", "", "release-plan", "source-review"],
				["octo-org", "score", "", "source-review"],
				["octo-org", "score", "release-plan", ""],
			] as const
		) {
			expect(() => childDocumentPath(segments[0], segments[1], segments[2], segments[3])).toThrow(
				TypeError,
			);
		}
	});
});

describe("research workspace paths", () => {
	it("builds and parses the canonical route", () => {
		let path = researchWorkspacePath("octo-org", "score", "release-plan", "workspace-1");
		expect(path).toBe("/documents/octo-org/score/release-plan/research/workspace-1");
		expect(parseResearchWorkspacePath(path)).toEqual({
			owner: "octo-org",
			repository: "score",
			slug: "release-plan",
			workspaceId: "workspace-1",
		});
		expect(parseDocumentPath(path)).toBeUndefined();
	});

	it("encodes and decodes every dynamic segment", () => {
		let path = researchWorkspacePath(
			"München/org",
			"計画 roadmap",
			"café?#100%",
			"研究/workspace ?#%",
		);
		expect(path).toBe(
			"/documents/M%C3%BCnchen%2Forg/%E8%A8%88%E7%94%BB%20roadmap/caf%C3%A9%3F%23100%25/research/%E7%A0%94%E7%A9%B6%2Fworkspace%20%3F%23%25",
		);
		expect(parseResearchWorkspacePath(path)).toEqual({
			owner: "München/org",
			repository: "計画 roadmap",
			slug: "café?#100%",
			workspaceId: "研究/workspace ?#%",
		});
	});

	it("accepts one trailing slash", () => {
		expect(
			parseResearchWorkspacePath(
				"/documents/octo-org/score/release-plan/research/workspace-1/",
			),
		).toEqual({
			owner: "octo-org",
			repository: "score",
			slug: "release-plan",
			workspaceId: "workspace-1",
		});
		expect(
			parseResearchWorkspacePath(
				"/documents/octo-org/score/release-plan/research/workspace-1//",
			),
		).toBeUndefined();
	});

	it("rejects malformed percent encoding in every dynamic segment", () => {
		for (
			let path of [
				"/documents/%/score/release-plan/research/workspace-1",
				"/documents/octo-org/%E0%A4%A/release-plan/research/workspace-1",
				"/documents/octo-org/score/%C0%AF/research/workspace-1",
				"/documents/octo-org/score/release-plan/research/%ZZ",
			]
		) {
			expect(parseResearchWorkspacePath(path)).toBeUndefined();
		}
	});

	it("rejects missing, empty, malformed and extra route segments", () => {
		for (
			let path of [
				"/documents/octo-org/score/release-plan/research",
				"/documents/octo-org/score/release-plan/research/",
				"/documents//score/release-plan/research/workspace-1",
				"/documents/octo-org//release-plan/research/workspace-1",
				"/documents/octo-org/score//research/workspace-1",
				"/documents/octo-org/score/release-plan//workspace-1",
				"/documents/octo-org/score/release-plan/research//",
				"/documents/octo-org/score/release-plan/research/workspace-1/extra",
				"/documents/octo-org/score/release-plan/Research/workspace-1",
				"/documents/octo-org/score/release-plan/research/workspace-1?view=all",
				"documents/octo-org/score/release-plan/research/workspace-1",
			]
		) {
			expect(parseResearchWorkspacePath(path)).toBeUndefined();
		}
	});

	it("rejects empty helper segments", () => {
		for (
			let segments of [
				["", "score", "release-plan", "workspace-1"],
				["octo-org", "", "release-plan", "workspace-1"],
				["octo-org", "score", "", "workspace-1"],
				["octo-org", "score", "release-plan", ""],
			] as const
		) {
			expect(() => researchWorkspacePath(segments[0], segments[1], segments[2], segments[3]))
				.toThrow(TypeError);
		}
	});
});
