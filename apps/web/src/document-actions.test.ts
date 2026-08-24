import { describe, expect, it } from "bun:test";

import {
	beginDocumentLoad,
	completeDocumentPage,
	failDocumentLoad,
	newestDocument,
	projectDocuments,
	removeLoadedDocument,
	replaceLoadedDocument,
	updateLoadedDocument,
} from "./document-actions";
import { searchAvailableDocuments } from "./document-search-dialog";

import type * as Api from "./api";
import type { LoadedDocuments } from "./document-actions";

function channel(id: string, title: string, repositoryId: string): Api.Channel {
	return {
		id,
		repositoryId,
		repositoryOwner: "acme",
		repositoryName: repositoryId,
		title,
		slug: title.toLowerCase().replaceAll(" ", "-"),
		createdBy: "user",
		revision: 1,
		createdAt: "2026-08-21T00:00:00.000Z",
		updatedAt: "2026-08-21T00:00:00.000Z",
		descriptionRevision: 0,
	};
}

let projects = [
	{
		project: {
			repositoryId: "R_one",
			repositoryOwner: "acme",
			repositoryName: "one",
			position: 0,
			available: true,
		},
		channels: [channel("doc-one", "Product brief", "R_one")],
	},
	{
		project: {
			repositoryId: "R_two",
			repositoryOwner: "acme",
			repositoryName: "two",
			position: 1,
			available: true,
		},
		channels: [channel("doc-two", "Architecture notes", "R_two")],
	},
	{
		project: {
			repositoryId: "R_unavailable",
			repositoryOwner: "acme",
			repositoryName: "unavailable",
			position: 2,
			available: false,
		},
		channels: [channel("hidden", "Product secret", "R_unavailable")],
	},
];

describe("document actions", () => {
	it("gives every Project one explicit document state", () => {
		let entries = projectDocuments({
			projects: projects.map(entry => entry.project),
			lastDocumentId: "doc-one",
		}, {});

		expect(entries.map(entry => entry.documents.status)).toEqual([
			"loading",
			"loading",
			"unavailable",
		]);
	});

	it("keeps one explicit load state across pagination and failure", () => {
		let loading = beginDocumentLoad();
		let first = completeDocumentPage(
			loading,
			[channel("doc-one", "Product brief", "R_one")],
			"next",
		);
		let more = beginDocumentLoad(first);
		let complete = completeDocumentPage(
			more,
			[
				channel("doc-one", "Product brief", "R_one"),
				channel("doc-two", "Architecture", "R_one"),
			],
		);
		let failed = failDocumentLoad(complete, new Error("offline"));

		expect(loading).toEqual({ status: "loading", channels: [] });
		expect(first).toMatchObject({ status: "ready", nextCursor: "next" });
		expect(more).toMatchObject({ status: "loading", nextCursor: "next" });
		expect(complete.channels.map(document => document.id)).toEqual(["doc-one", "doc-two"]);
		expect(failed).toMatchObject({ status: "error", message: "offline" });
		expect(failed.channels).toBe(complete.channels);
	});

	it("searches available Projects through every query-bound page", async () => {
		let calls: string[] = [];
		let load: typeof Api.channels = async (owner, repository, options = {}) => {
			calls.push(
				`${owner}/${repository}:${options.cursor ?? "first"}:${options.query ?? ""}:${
					options.includeArchived ?? false
				}`,
			);
			let repositoryId = repository === "one" ? "R_one" : "R_two";
			let loaded = channel(
				`${repository}-${options.cursor ?? "first"}`,
				"Product",
				repositoryId,
			);
			if (repository === "one" && !options.cursor) {
				loaded = {
					...loaded,
					descriptionRevision: 1,
					description: "Defines the product launch.",
				};
			}
			return {
				repository: {
					defaultBranch: "main",
					fullName: `${owner}/${repository}`,
					id: repositoryId,
					name: repository,
					owner,
					permissions: { admin: false, pull: true, push: true },
					private: false,
					url: `https://github.com/${owner}/${repository}`,
				},
				canEdit: true,
				channels: [loaded],
				nextCursor: repository === "one" && !options.cursor ? "next" : undefined,
			};
		};
		let search = await searchAvailableDocuments(
			projects.map(entry => entry.project),
			"product",
			false,
			load,
		);

		expect(search.results.map(result => result.channel.id)).toEqual([
			"one-first",
			"one-next",
			"two-first",
		]);
		expect(search.failedProjectIds).toEqual([]);
		expect(search.results[0]).toMatchObject({
			project: { repositoryOwner: "acme", repositoryName: "one" },
			channel: { description: "Defines the product launch." },
		});
		expect(calls).toEqual([
			"acme/one:first:product:false",
			"acme/two:first:product:false",
			"acme/one:next:product:false",
		]);
	});

	it("binds archived search pagination to the selected catalogue mode", async () => {
		let modes: boolean[] = [];
		await searchAvailableDocuments(
			[projects[0]!.project],
			"",
			true,
			async (_owner, _repository, options = {}) => {
				modes.push(options.includeArchived === true);
				return {
					repository: {} as Api.Repository,
					canEdit: true,
					channels: [],
					...(options.cursor ? {} : { nextCursor: "next" }),
				};
			},
		);

		expect(modes).toEqual([true, true]);
	});

	it("replaces a renamed document in its loaded Project", () => {
		let renamed = { ...projects[0]!.channels![0]!, title: "Team brief", revision: 2 };
		let documents: LoadedDocuments = {
			R_one: { status: "ready", channels: projects[0]!.channels! },
			R_two: { status: "ready", channels: projects[1]!.channels! },
		};
		let next = replaceLoadedDocument(documents, renamed);
		let inserted = replaceLoadedDocument({}, channel("doc-three", "New", "R_one"));
		let updated = updateLoadedDocument(documents, "doc-one", {
			title: "Socket title",
			slug: "socket-title",
			updatedAt: "2026-08-22T00:00:00.000Z",
			descriptionRevision: 0,
		});

		expect(next.R_one!.channels![0]).toMatchObject({ id: "doc-one", title: "Team brief" });
		expect(next.R_two).toBe(documents.R_two);
		expect(inserted.R_one?.channels[0]?.id).toBe("doc-three");
		expect(updated.R_one?.channels[0]).toMatchObject({
			title: "Socket title",
			slug: "socket-title",
		});
	});

	it("replaces an authoritative first page and removes deleted documents explicitly", () => {
		let first = channel("first", "First", "R_one");
		let stale = channel("stale", "Stale", "R_one");
		let current = { status: "ready" as const, channels: [stale], nextCursor: "old" };
		let refreshed = completeDocumentPage(current, [first], "next", true);
		let loaded: LoadedDocuments = { R_one: refreshed };

		expect(refreshed.channels.map(document => document.id)).toEqual(["first"]);
		expect(removeLoadedDocument(loaded, first.id).R_one?.channels).toEqual([]);
		expect(removeLoadedDocument(loaded, "missing")).toBe(loaded);
	});

	it("retains a document inserted after a first-page request began", () => {
		let existing = channel("existing", "Existing", "R_one");
		let created = channel("created", "Created", "R_one");
		let current = { status: "loading" as const, channels: [existing, created] };
		let refreshed = completeDocumentPage(
			current,
			[existing],
			undefined,
			true,
			new Set([created.id]),
		);

		expect(refreshed.channels.map(document => document.id)).toEqual(["created", "existing"]);
	});

	it("keeps newer document metadata when an older response arrives later", () => {
		let current = {
			...projects[0]!.channels![0]!,
			title: "Latest title",
			updatedAt: "2026-08-22T00:00:00.000Z",
		};
		let stale = {
			...current,
			title: "Stale title",
			updatedAt: "2026-08-21T00:00:00.000Z",
		};
		let documents: LoadedDocuments = {
			R_one: { status: "ready", channels: [current] },
		};

		expect(replaceLoadedDocument(documents, stale).R_one?.channels[0]).toBe(current);
		expect(
			updateLoadedDocument(documents, current.id, {
				title: stale.title,
				slug: stale.slug,
				updatedAt: stale.updatedAt,
				descriptionRevision: stale.descriptionRevision,
			}).R_one?.channels[0],
		).toBe(current);
	});

	it("merges generated descriptions independently from core metadata", () => {
		let current = {
			...channel("doc-one", "Current title", "R_one"),
			updatedAt: "2026-08-23T00:00:00.000Z",
			descriptionRevision: 1,
			description: "Earlier generated description",
		};
		let staleHttpWithNewDescription = {
			...current,
			title: "Stale title",
			updatedAt: "2026-08-22T00:00:00.000Z",
			descriptionRevision: 2,
			description: "Latest generated description",
		};
		let newerSocketWithOldDescription = {
			...current,
			title: "Renamed title",
			slug: "renamed-title",
			updatedAt: "2026-08-24T00:00:00.000Z",
			descriptionRevision: 1,
			description: "Earlier generated description",
		};

		let described = newestDocument(current, staleHttpWithNewDescription);
		expect(described).toMatchObject({
			title: "Current title",
			descriptionRevision: 2,
			description: "Latest generated description",
		});
		let renamed = newestDocument(described, newerSocketWithOldDescription);
		expect(renamed).toMatchObject({
			title: "Renamed title",
			slug: "renamed-title",
			descriptionRevision: 2,
			description: "Latest generated description",
		});

		let refreshed = completeDocumentPage(
			{ status: "loading", channels: [current] },
			[staleHttpWithNewDescription],
			undefined,
			true,
		);
		expect(refreshed.channels[0]).toMatchObject({
			title: "Current title",
			descriptionRevision: 2,
			description: "Latest generated description",
		});
	});
});
