import { describe, expect, it } from "bun:test";

import {
	summaryLine,
	versionChange,
	versionSummaryDefinition,
	versionSummaryKey,
} from "./version-summary";

import type { JobExecution } from "./registry";
import type { VersionChange, VersionSummaryInput } from "./version-summary";
import type { BackgroundJob, StoredDocumentVersion } from "../storage/model";

function stored(id: string, source: string, sourceHash: string): StoredDocumentVersion {
	let at = new Date(2026, 9, 14);
	return { id, channelId: "doc", revision: 1, source, sourceHash, startedAt: at, updatedAt: at };
}

function execution(input: VersionSummaryInput): JobExecution<VersionSummaryInput> {
	return {
		job: { id: "job", channelId: "doc", input } as unknown as BackgroundJob,
		input,
		credential: { kind: "none" },
		signal: new AbortController().signal,
		deadline: new Date(Date.now() + 60_000),
		progress: async () => {},
	};
}

describe("history summaries", () => {
	it("describes a session by the blocks it removed and added", () => {
		let before = "# Plan\n\n## Goals\n\nShip it.\n\n## Risks\n\nNone.\n";
		let after = "# Plan\n\n## Goals\n\nShip it carefully.\n\n## Risks\n\nNone.\n";
		expect(versionChange("b", after, before)).toEqual({
			id: "b",
			removed: ["Ship it."],
			added: ["Ship it carefully."],
			created: false,
		});
		expect(versionChange("a", before, undefined)).toMatchObject({ created: true, removed: [] });
	});

	it("keeps summaries to one short line", () => {
		expect(summaryLine("  Rewrote\nVisibility levels. ")).toBe("Rewrote Visibility levels");
		expect(() => summaryLine("")).toThrow();
		expect(() => summaryLine("x".repeat(121))).toThrow();
	});

	it("keys a request by its sessions and their sources", () => {
		let one = versionSummaryKey([{ id: "a", sourceHash: "h1" }]);
		expect(versionSummaryKey([{ id: "a", sourceHash: "h1" }])).toBe(one);
		expect(versionSummaryKey([{ id: "a", sourceHash: "h2" }])).not.toBe(one);
	});

	it("summarises current sessions in one turn and stores only those still current", async () => {
		let versions = new Map([
			["b", stored("b", "# Plan\n\nNew text.\n", "hb")],
			["a", stored("a", "# Plan\n\nOld text.\n", "ha")],
		]);
		let asked: VersionChange[][] = [];
		let saved: { id: string; sourceHash: string; summary: string }[] = [];
		let definition = versionSummaryDefinition({
			config: { agent: true, historyModel: "small" },
			versions: {
				get: async (_channel, id) => versions.get(id),
				previous: async (_channel, id) => id === "b" ? versions.get("a") : undefined,
				summarize: async input => {
					saved.push({ id: input.id, sourceHash: input.sourceHash, summary: input.summary });
					return true;
				},
			},
			engine: async (_execution, changes) => {
				asked.push(changes);
				return {
					model: "small",
					summaries: [
						{ id: "b", summary: "Rewrote the opening." },
						{ id: "stranger", summary: "Ignored" },
					],
				};
			},
		});

		let artifact = await definition.execute(execution({
			generatorVersion: 1,
			versions: [{ id: "b", sourceHash: "hb" }, { id: "a", sourceHash: "moved-on" }],
		}));
		expect(asked).toHaveLength(1);
		expect(asked[0]!.map(change => change.id)).toEqual(["b"]);
		expect(artifact.summaries).toEqual([
			{ id: "b", sourceHash: "hb", summary: "Rewrote the opening" },
		]);

		let committed = false;
		await definition.publish!({
			job: { channelId: "doc" } as BackgroundJob,
			artifact,
			commit: async () => {
				committed = true;
			},
		});
		expect(committed).toBe(true);
		expect(saved).toEqual([{ id: "b", sourceHash: "hb", summary: "Rewrote the opening" }]);
	});
});
