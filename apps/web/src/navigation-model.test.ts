import { describe, expect, it } from "bun:test";

import {
	activeProject,
	canManageProject,
	documentCreationTarget,
	documentDestination,
	isDocumentWorkspaceRoute,
	landingDocument,
	navigationMode,
	researchChildDestination,
	researchChildNavigation,
} from "./navigation-model";

import type { ProjectDocuments } from "./document-actions";
import type * as Api from "./api";

type MatchMedia = (query: string) => { matches: boolean };

function mediaAt(width: number): MatchMedia {
	return query => {
		let maximum = /\(max-width: (\d+)px\)/.exec(query);
		return { matches: maximum !== null && width <= Number(maximum[1]) };
	};
}

let projects: ProjectDocuments[] = [
	{
		project: {
			repositoryId: "R_unavailable",
			repositoryOwner: "acme",
			repositoryName: "unavailable",
			position: 0,
			available: false,
		},
		documents: { status: "unavailable", channels: [] },
	},
	{
		project: {
			repositoryId: "R_one",
			repositoryOwner: "acme",
			repositoryName: "one",
			position: 1,
			available: true,
		},
		documents: {
			status: "ready",
			channels: [
				{ id: "first-accessible", repositoryId: "R_one", slug: "first-accessible" },
				{ id: "channel-one", repositoryId: "R_one", slug: "channel-one" },
			] as Api.Channel[],
		},
	},
	{
		project: {
			repositoryId: "R_two",
			repositoryOwner: "acme",
			repositoryName: "two",
			position: 2,
			available: true,
		},
		documents: {
			status: "ready",
			channels: [{
				id: "channel-two",
				repositoryId: "R_two",
				slug: "channel-two",
			}] as Api.Channel[],
		},
	},
];

describe("navigation model", () => {
	it("classifies every route whose visit can be retried", () => {
		for (
			let route of [
				{ id: "document-id", page: "channel" as const },
				{
					owner: "acme",
					page: "document" as const,
					repository: "one",
					slug: "parent",
				},
				{
					childSlug: "child",
					owner: "acme",
					page: "child" as const,
					parentSlug: "parent",
					repository: "one",
				},
			]
		) expect(isDocumentWorkspaceRoute(route)).toBe(true);
		expect(isDocumentWorkspaceRoute({ page: "repositories" })).toBe(false);
	});

	it("uses the same drawer boundary as the shell", () => {
		expect(navigationMode(mediaAt(1023))).toBe("drawer");
		expect(navigationMode(mediaAt(1024))).toBe("inline");
	});

	it("finds the Project containing the current document", () => {
		expect(activeProject(projects, "channel-two")?.repositoryId).toBe("R_two");
		expect(activeProject(projects, "not-loaded", "R_two")?.repositoryId).toBe("R_two");
		expect(activeProject(projects, "missing")).toBeUndefined();
	});

	it("falls back to the first accessible document", () => {
		expect(landingDocument(projects)).toBe("first-accessible");
		expect(landingDocument(projects, "channel-two")).toBe("channel-two");
	});

	it("never chooses an archived document for the active landing", () => {
		let archived: ProjectDocuments[] = projects.map(entry =>
			entry.project.repositoryId === "R_one" && entry.documents.status !== "unavailable"
				? {
					...entry,
					documents: {
						...entry.documents,
						channels: entry.documents.channels.map(channel => ({
							...channel,
							archivedAt: "2026-08-23T00:00:00.000Z",
						})),
					},
				}
				: entry
		);

		expect(landingDocument(archived, "channel-one")).toBe("channel-two");
		expect(landingDocument(archived)).toBe("channel-two");
	});

	it("has no landing document until an accessible Project has one", () => {
		expect(landingDocument(projects.slice(0, 1))).toBeUndefined();
		expect(landingDocument([])).toBeUndefined();
	});

	it("trusts the canonical last document while Projects are still loading", () => {
		let incomplete = projects.map(entry =>
			entry.project.repositoryId === "R_two"
				? { ...entry, documents: { ...entry.documents, status: "loading" as const } }
				: entry
		);

		expect(landingDocument(incomplete, "not-loaded-yet")).toBe("not-loaded-yet");
		expect(landingDocument(incomplete, "channel-one")).toBe("channel-one");
	});

	it("resolves a loaded document route without waiting on persistence", () => {
		expect(documentDestination(projects, "channel-two")).toBe(
			"/documents/acme/two/channel-two",
		);
		expect(documentDestination(projects, "missing")).toBe("/channels/missing");
		expect(documentDestination(projects, "channel-two", "/explicit")).toBe("/explicit");
	});

	it("resolves a loaded child only through its parent route", () => {
		let parentEntry = projects[1]!;
		if (parentEntry.documents.status === "unavailable") throw new Error("fixture is unavailable");
		let parent = parentEntry.documents.channels[1]!;
		let child = {
			...parent,
			id: "channel-child",
			parentChannelId: parent.id,
			slug: "channel-child",
		};
		let nested: ProjectDocuments[] = [{
			...parentEntry,
			documents: {
				...parentEntry.documents,
				channels: [child, parent],
			},
		}];

		expect(documentDestination(nested, child.id)).toBe(
			"/documents/acme/one/channel-one/children/channel-child",
		);
		expect(landingDocument(nested)).toBe(parent.id);
		expect(landingDocument(nested, child.id)).toBe(child.id);
	});

	it("opens a ready research child in its parent repository", () => {
		expect(researchChildDestination(
			{
				repositoryOwner: "acme space",
				repositoryName: "docs/tools",
				slug: "release plan",
			},
			{ slug: "rollout evidence" },
		)).toBe(
			"/documents/acme%20space/docs%2Ftools/release%20plan/children/rollout%20evidence",
		);
	});

	it("carries an explicit ready-card opener into child navigation", () => {
		let opener = { current: { focus() {} } as HTMLElement };
		expect(researchChildNavigation(
			{
				repositoryOwner: "acme space",
				repositoryName: "docs/tools",
				slug: "release plan",
			},
			{ slug: "rollout evidence" },
			opener,
		)).toEqual({
			destination:
				"/documents/acme%20space/docs%2Ftools/release%20plan/children/rollout%20evidence",
			opener,
		});
	});

	it("allows mutations only for push or admin navigation repositories", () => {
		let viewerProject = {
			...projects[1]!.project,
			repository: {
				id: "R_one",
				owner: "acme",
				name: "one",
				fullName: "acme/one",
				permissions: { pull: true, push: false, admin: false },
			},
		};
		let editorProject = {
			...viewerProject,
			repository: {
				...viewerProject.repository,
				permissions: { pull: true, push: true, admin: false },
			},
		};
		let adminProject = {
			...viewerProject,
			repository: {
				...viewerProject.repository,
				permissions: { pull: true, push: false, admin: true },
			},
		};

		expect(canManageProject(viewerProject)).toBe(false);
		expect(canManageProject(editorProject)).toBe(true);
		expect(canManageProject(adminProject)).toBe(true);
	});
});

function project(id: string, permission: "push" | "admin" | "pull" = "push") {
	return {
		repositoryId: id,
		repositoryOwner: "acme",
		repositoryName: id,
		position: 0,
		available: true,
		repository: {
			id,
			owner: "acme",
			name: id,
			fullName: `acme/${id}`,
			permissions: { pull: true, push: permission === "push", admin: permission === "admin" },
		},
	};
}

describe("document creation targets", () => {
	let first = project("first");
	let second = project("second", "admin");
	let viewer = project("viewer", "pull");
	let unavailable = { ...project("unavailable"), available: false };

	it("waits for navigation and unresolved current-document context", () => {
		expect(documentCreationTarget(undefined, undefined)).toEqual({ type: "loading" });
		expect(documentCreationTarget([first], undefined, true)).toEqual({ type: "loading" });
		expect(documentCreationTarget([first], first, true)).toEqual({
			type: "project",
			project: first,
		});
	});

	it("creates in the sole writable project without any document catalogue", () => {
		expect(documentCreationTarget([viewer, first, unavailable], undefined)).toEqual({
			type: "project",
			project: first,
		});
		expect(documentCreationTarget([viewer, second], viewer)).toEqual({
			type: "project",
			project: second,
		});
	});

	it("prefers the current project and asks only when the target is ambiguous", () => {
		expect(documentCreationTarget([first, second], second)).toEqual({
			type: "project",
			project: second,
		});
		expect(documentCreationTarget([first, viewer, second, unavailable], undefined)).toEqual({
			type: "choose",
			projects: [first, second],
		});
	});

	it("uses current navigation permissions rather than stale document context", () => {
		let revoked = {
			...first,
			repository: { ...first.repository, permissions: viewer.repository.permissions },
		};
		expect(documentCreationTarget([revoked, second], first)).toEqual({
			type: "project",
			project: second,
		});
		expect(documentCreationTarget([viewer, unavailable], unavailable)).toEqual({
			type: "unavailable",
		});
		expect(documentCreationTarget([], undefined)).toEqual({ type: "unavailable" });
	});
});
