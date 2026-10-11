import { describe, expect, it } from "bun:test";

import {
	documentGroups,
	editedLabel,
	filterDocumentGroups,
	recentDocuments,
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

	it("lists recents newest first only when the tree holds more than they repeat", () => {
		expect(recentDocuments([offline, release], 3)).toEqual([]);
		let more = [
			release,
			offline,
			channel("d", "D", "2026-10-01T00:00:00Z"),
			channel("e", "E", "2026-10-11T11:00:00Z"),
			channel("f", "F", "2026-09-01T00:00:00Z"),
		];
		expect(recentDocuments(more, 3).map(value => value.id)).toEqual(["e", "a", "b"]);
	});

	it("says when a document was edited", () => {
		let now = Date.parse("2026-10-11T12:00:00");
		let at = (value: string) => new Date(value).toISOString();
		expect(editedLabel(at("2026-10-11T11:59:40"), now)).toBe("Edited just now");
		expect(editedLabel(at("2026-10-11T11:58:00"), now)).toBe("Edited 2 min ago");
		expect(editedLabel(at("2026-10-11T09:00:00"), now)).toBe("Edited 3 hr ago");
		expect(editedLabel(at("2026-10-10T08:00:00"), now)).toBe("Edited yesterday");
		expect(editedLabel(at("2026-10-07T08:00:00"), now, "en-US")).toBe("Edited Wednesday");
		expect(editedLabel(at("2026-09-20T08:00:00"), now, "en-US")).toBe("Edited Sep 20");
		expect(editedLabel("not a date", now)).toBe("");
	});
});
