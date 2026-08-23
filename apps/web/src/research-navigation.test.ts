import { describe, expect, it } from "bun:test";

import {
	beginResearchLoad,
	completeResearchLoad,
	currentResearchRequest,
	upsertLoadedResearch,
} from "./research-navigation";

import type { Research } from "@chopin/protocol";
import type * as Api from "./api";

function workspace(id: string, revision: number, updatedAt: string): Research.WorkspaceSummary {
	return {
		id,
		channelId: "channel-one",
		title: id,
		proposedQuestion: "What changed?",
		origin: "sidebar",
		createdBy: "user-one",
		revision,
		createdAt: "2026-08-20T00:00:00.000Z",
		updatedAt,
	};
}

let channel: Api.ResearchParentChannel = {
	id: "channel-one",
	repositoryId: "R_one",
	repositoryOwner: "acme",
	repositoryName: "one",
	title: "Release plan",
	slug: "release-plan",
};

let repository: Api.Repository = {
	id: "R_one",
	owner: "acme",
	name: "one",
	fullName: "acme/one",
	private: true,
	url: "https://github.com/acme/one",
	defaultBranch: "main",
	permissions: { pull: true, push: true, admin: false },
};

describe("repository research state", () => {
	it("accepts only the current non-aborted repository request", () => {
		let first = new AbortController();
		let second = new AbortController();
		let loads = new Map([["R_one", first]]);

		expect(currentResearchRequest(loads, "R_one", first)).toBe(true);
		loads.set("R_one", second);
		expect(currentResearchRequest(loads, "R_one", first)).toBe(false);
		expect(currentResearchRequest(loads, "R_one", second)).toBe(true);
		second.abort();
		expect(currentResearchRequest(loads, "R_one", second)).toBe(false);
	});

	it("keeps a newer local upsert when an older repository response settles", () => {
		let recent = workspace("research-one", 3, "2026-08-23T10:00:00.000Z");
		let stale = { ...recent, revision: 2, updatedAt: "2026-08-23T09:00:00.000Z" };
		let loaded = upsertLoadedResearch({}, "R_one", channel, recent);
		let next = completeResearchLoad(loaded.R_one ?? beginResearchLoad(), {
			repository,
			canEdit: true,
			channels: [{ channel, workspaces: [stale] }],
			truncated: false,
		});

		expect(next.channels[0]?.workspaces).toEqual([recent]);
	});

	it("retains a locally created child omitted by a stale repository response", () => {
		let created = workspace("research-new", 0, "2026-08-23T10:00:00.000Z");
		let loaded = upsertLoadedResearch({}, "R_one", channel, created);
		let next = completeResearchLoad(loaded.R_one!, {
			repository,
			canEdit: true,
			channels: [],
			truncated: false,
		});

		expect(next.channels[0]?.workspaces[0]).toBe(created);
	});
});
