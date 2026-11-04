import { describe, expect, it } from "bun:test";
import { buildBlockers, buildBlockerSummary } from "./build-blockers";

import type { ImplementationSnapshot } from "@chopin/protocol/implementation";

let snapshot: ImplementationSnapshot = {
	revision: 1,
	planRevision: 1,
	localAgent: true,
	buildReady: false,
	blockers: ["required investigations"],
	lifecycle: { execution: { state: "idle" }, history: [] },
	buildInvestigations: [{ id: "spike", brief: "Measure cold starts", reason: "Choose a cache" }],
};

describe("named build blockers", () => {
	it("targets each required investigation by identity", () => {
		expect(buildBlockers(snapshot)).toEqual([
			{ kind: "investigation", id: "spike", title: "Measure cold starts" },
		]);
		expect(buildBlockers(undefined)).toEqual([]);
	});
	it("names nothing while the document only has decisions left to answer", () => {
		// Decisions never hold Build back, so the server reports no blocker for them.
		expect(buildBlockers({ ...snapshot, buildReady: true, blockers: [], buildInvestigations: [] }))
			.toEqual([]);
	});
	it("summarises single and plural blockers without exposing titles in the capsule", () => {
		let items = buildBlockers(snapshot);
		expect(buildBlockerSummary(items)).toEqual({
			tone: "investigation",
			label: "1 investigation left",
		});
		expect(
			buildBlockerSummary([items[0]!, {
				kind: "investigation",
				id: "memory",
				title: "Measure memory",
			}]),
		)
			.toEqual({ tone: "investigation", label: "2 investigations left" });
	});
});
