import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
	currentReferencePickerRequest,
	ReferencePicker,
	referencePickerKeyAction,
	referencePickerRequestKey,
	searchReferenceTargets,
} from "./reference-picker";

import type * as Api from "../api";
import type { ReferenceSearchApi } from "./reference-picker";
import type { ReferenceTrigger } from "./references";

let REPOSITORY: Api.Repository = {
	id: "repository-one",
	owner: "octo-org",
	name: "score",
	fullName: "octo-org/score",
	private: true,
	url: "https://github.com/octo-org/score",
	defaultBranch: "main",
	permissions: { pull: true, push: true, admin: false },
};

function channel(id: string, title = id): Api.Channel {
	return {
		id,
		repositoryId: REPOSITORY.id,
		repositoryOwner: REPOSITORY.owner,
		repositoryName: REPOSITORY.name,
		title,
		slug: id,
		createdBy: "user-one",
		revision: 0,
		createdAt: "2026-08-23T00:00:00.000Z",
		updatedAt: "2026-08-23T00:00:00.000Z",
		descriptionRevision: 0,
	};
}

function trigger(query = ""): ReferenceTrigger {
	return {
		kind: "document",
		marker: "#",
		query,
		start: 0,
		end: query.length + 1,
	};
}

function api(channels: Api.Channel[]): ReferenceSearchApi {
	return {
		channels: async () => ({ repository: REPOSITORY, canEdit: true, channels }),
	};
}

describe("reference picker requests", () => {
	test("excludes the current document and caps document results", async () => {
		let documents = [
			channel("current"),
			...Array.from({ length: 12 }, (_, index) => channel(`channel-${index}`, `Release ${index}`)),
		];
		let result = await searchReferenceTargets(
			trigger(),
			REPOSITORY,
			"current",
			new AbortController().signal,
			api(documents),
		);

		expect(result.options).toHaveLength(10);
		expect(result.options[0]).toEqual({
			kind: "document",
			channelId: "channel-0",
			title: "Release 0",
			slug: "channel-0",
		});
		expect(result.options.some(item => item.kind === "document" && item.channelId === "current"))
			.toBe(
				false,
			);
	});

	test("maps generated descriptions without changing document reference identity", async () => {
		let described = {
			...channel("release", "Release plan"),
			descriptionRevision: 3,
			description: "Coordinates launch readiness across the repository.",
		};
		let result = await searchReferenceTargets(
			trigger(),
			REPOSITORY,
			"current",
			new AbortController().signal,
			api([described]),
		);

		expect(result.options).toEqual([{
			kind: "document",
			channelId: "release",
			title: "Release plan",
			slug: "release",
			description: "Coordinates launch readiness across the repository.",
		}]);
	});

	test("paginates documents until ten non-current matches are available", async () => {
		let calls: Array<string | undefined> = [];
		let pages = [
			{ channels: [channel("current"), channel("one"), channel("two")], nextCursor: "two" },
			{
				channels: Array.from({ length: 5 }, (_, index) => channel(`middle-${index}`)),
				nextCursor: "three",
			},
			{ channels: Array.from({ length: 5 }, (_, index) => channel(`last-${index}`)) },
		];
		let result = await searchReferenceTargets(
			trigger(),
			REPOSITORY,
			"current",
			new AbortController().signal,
			{
				channels: async (_owner, _repository, options) => {
					calls.push(options?.cursor);
					expect(options?.includeArchived).toBe(false);
					let page = pages[calls.length - 1]!;
					return { repository: REPOSITORY, canEdit: true, ...page };
				},
			},
		);

		expect(calls).toEqual([undefined, "two", "three"]);
		expect(result.options).toHaveLength(10);
		expect(result.truncated).toBe(true);
	});

	test("bounds document pagination to five pages", async () => {
		let calls = 0;
		let result = await searchReferenceTargets(
			trigger("rare"),
			REPOSITORY,
			"current",
			new AbortController().signal,
			{
				channels: async () => ({
					repository: REPOSITORY,
					canEdit: true,
					channels: [channel(`result-${++calls}`)],
					nextCursor: `page-${calls + 1}`,
				}),
			},
		);

		expect(calls).toBe(5);
		expect(result.options).toHaveLength(5);
		expect(result.truncated).toBe(true);
	});

	test("recognizes only the latest live request", () => {
		let old = { id: 1, key: "old", controller: new AbortController() };
		let current = { id: 2, key: "current", controller: new AbortController() };
		expect(currentReferencePickerRequest(current, old)).toBe(false);
		expect(currentReferencePickerRequest(current, current)).toBe(true);
		current.controller.abort();
		expect(currentReferencePickerRequest(current, current)).toBe(false);
	});

	test("keys reopened requests by repository, room, and trigger", () => {
		let selected = trigger("release");
		let first = referencePickerRequestKey(selected, REPOSITORY, "room-one");
		expect(referencePickerRequestKey(selected, REPOSITORY, "room-two")).not.toBe(first);
		expect(referencePickerRequestKey(selected, { ...REPOSITORY, id: "other" }, "room-one"))
			.not.toBe(first);
	});

	test("does not consume picker keys without options or during IME composition", () => {
		expect(referencePickerKeyAction({ key: "Enter" }, false)).toBeUndefined();
		expect(referencePickerKeyAction({ key: "ArrowDown" }, false)).toBeUndefined();
		expect(referencePickerKeyAction({ key: "Enter", isComposing: true }, true)).toBeUndefined();
		expect(referencePickerKeyAction({ key: "ArrowDown", keyCode: 229 }, true)).toBeUndefined();
		expect(referencePickerKeyAction({ key: "Escape", isComposing: true }, false)).toBeUndefined();
		expect(referencePickerKeyAction({ key: "Enter" }, true)).toBe("select");
	});
});

describe("reference picker accessibility", () => {
	test("labels the listbox and exposes active options", () => {
		let markup = renderToStaticMarkup(createElement(ReferencePicker, {
			active: 0,
			id: "reference-list",
			onActive: () => {},
			onSelect: () => {},
			state: {
				status: "ready",
				options: [{ kind: "document", channelId: "release", title: "Release plan" }],
			},
		}));

		expect(markup).toContain('aria-label="Document references"');
		expect(markup).toContain('role="listbox"');
		expect(markup).toContain('role="option"');
		expect(markup).toContain('aria-selected="true"');
		expect(markup).toContain("Release plan");
	});

	test("describes a document with generated text and slug without changing its exact name", () => {
		let markup = renderToStaticMarkup(createElement(ReferencePicker, {
			active: 0,
			id: "reference-list",
			onActive: () => {},
			onSelect: () => {},
			state: {
				status: "ready",
				options: [{
					kind: "document",
					channelId: "release",
					title: "Release plan",
					slug: "release-plan",
					description: "Coordinates launch readiness.",
				}],
			},
		}));

		expect(markup).toContain('aria-label="Release plan"');
		expect(markup).toContain(
			'aria-describedby="reference-list-option-0-description reference-list-option-0-slug"',
		);
		expect(markup).toContain("Coordinates launch readiness.");
		expect(markup).toContain(">release-plan</span>");
	});

	test("announces loading, empty, errors, and the reference limit", () => {
		let render = (state: Parameters<typeof ReferencePicker>[0]["state"]) =>
			renderToStaticMarkup(createElement(ReferencePicker, {
				active: 0,
				id: "document-list",
				onActive: () => {},
				onSelect: () => {},
				state,
			}));

		expect(render({ status: "loading", options: [] })).toContain("Loading documents...");
		expect(render({ status: "ready", options: [] })).toContain("No matching documents.");
		expect(render({ status: "error", options: [], error: new Error("Unavailable") }))
			.toContain('role="alert">Unavailable');
		expect(render({ status: "limit", options: [] })).toContain(
			"A message can include up to 10 references.",
		);
		let truncated = render({ status: "ready", options: [], truncated: true });
		expect(truncated).toContain("No matches in the available documents.");
		expect(truncated).toContain("Some documents are not shown.");
		expect(truncated).not.toContain("No matching documents.");
	});
});
