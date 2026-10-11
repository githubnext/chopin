import { describe, expect, it } from "bun:test";

import {
	documentGroups,
	filterDocumentGroups,
	readRecentIds,
	recentDocuments,
	rememberOpened,
} from "./documents-sheet-model";

import type * as Api from "./api";

describe("documents sheet model", () => {
	let channel = (id: string, title: string, updatedAt: string, parentChannelId?: string) =>
		({
			id,
			title,
			updatedAt,
			parentChannelId,
			repositoryId: "R",
			repositoryOwner: "o",
			repositoryName: "r",
			slug: id,
			createdBy: "u",
			revision: 1,
			createdAt: updatedAt,
			descriptionRevision: 0,
		}) satisfies Api.Channel;

	let offline = channel("a", "Offline sync", "2026-10-11T10:00:00Z");
	let release = channel("b", "Release checklist", "2026-10-10T10:00:00Z");
	let eviction = channel("c", "IndexedDB eviction", "2026-10-09T10:00:00Z", "a");
	let groups = documentGroups([offline, release, eviction], false);

	it("filters titles case-insensitively and keeps parents for matching children", () => {
		expect(filterDocumentGroups(groups, "  ")).toBe(groups);
		expect(filterDocumentGroups(groups, "RELEASE")).toEqual([{ parent: release, children: [] }]);
		expect(filterDocumentGroups(groups, "eviction")).toEqual([
			{ parent: offline, children: [eviction] },
		]);
		expect(filterDocumentGroups(groups, "offline")).toEqual([
			{ parent: offline, children: [eviction] },
		]);
		expect(filterDocumentGroups(groups, "nothing")).toEqual([]);
	});

	it("remembers opened documents per project and shows two or more besides the current", () => {
		let values = new Map<string, string>();
		let storage = {
			getItem: (key: string) => values.get(key) ?? null,
			setItem: (key: string, value: string) => void values.set(key, value),
		};
		for (let id of ["a", "b", "a", "c"]) rememberOpened(storage, "U", "R", id);
		rememberOpened(storage, "U", "Other", "z");
		expect(readRecentIds(storage, "U", "R")).toEqual(["c", "a", "b"]);
		expect(readRecentIds(storage, "U", "Other")).toEqual(["z"]);
		expect(readRecentIds(storage, "V", "R")).toEqual([]);
		let archived = { ...release, archivedAt: "2026-10-11T00:00:00Z" };
		expect(recentDocuments(["c", "a", "b"], [offline, archived, eviction], "c")).toEqual([]);
		expect(recentDocuments(["c", "a", "b"], [offline, release, eviction], "c")).toEqual([
			offline,
			release,
		]);
		expect(recentDocuments(["gone", "a"], [offline], undefined)).toEqual([]);
		let broken = {
			getItem: () => "{not json",
			setItem: () => {
				throw new Error("full");
			},
		};
		expect(readRecentIds(broken, "U", "R")).toEqual([]);
		expect(() => rememberOpened(broken, "U", "R", "a")).not.toThrow();
	});
});
