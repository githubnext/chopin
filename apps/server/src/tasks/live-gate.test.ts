import { describe, expect, it } from "bun:test";

import { changedLines, jevGate } from "./live-gate";

import type { JevRequest, JevResult } from "../conversation-plan/jev";
import type { LiveDelta } from "./live-sync";

let delta: LiveDelta = {
	channelId: "c",
	baseRevision: 1,
	targetRevision: 2,
	baseSource: "# Title\n\nOld line.\n",
	source: "# Title\n\nNew line.\n",
	pullRequests: [],
};

function answering(noul: number, seen: JevRequest[] = []) {
	return async (request: JevRequest): Promise<JevResult> => {
		seen.push(request);
		return {
			model: "m",
			answers: { rebuild: { type: "noul", noul } },
			usage: { input_tokens: 1, output_tokens: 1 },
			latencyMs: 1,
		};
	};
}

describe("Jev live gate", () => {
	it("sends a compact changed-line delta", async () => {
		let seen: JevRequest[] = [];
		await jevGate(answering(0.9, seen)).classify(delta);
		expect(seen[0]!.state).toEqual({ changes: "- Old line.\n+ New line." });
		expect(changedLines("a\nb", "a\nb")).toBe("");
	});
	it("rebuilds when Jev says true and skips when false", async () => {
		expect(await jevGate(answering(0.5)).classify(delta)).toBe(true);
		expect(await jevGate(answering(0.2)).classify(delta)).toBe(false);
	});
	it("fails open to a source comparison on error", async () => {
		let failing = jevGate(async () => {
			throw new Error("Jev request timed out");
		});
		expect(await failing.classify(delta)).toBe(true);
		expect(await failing.classify({ ...delta, source: delta.baseSource })).toBe(false);
	});
});
