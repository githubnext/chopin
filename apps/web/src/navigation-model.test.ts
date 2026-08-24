import { describe, expect, it } from "bun:test";

import {
	activeProject,
	beginProjectCreation,
	canManageProject,
	documentDestination,
	finishProjectCreation,
	landingDocument,
	navigationMode,
	researchChildDestination,
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

	it("opens a ready research child in its parent repository", () => {
		expect(researchChildDestination(
			{ repositoryOwner: "acme space", repositoryName: "docs/tools" },
			{ slug: "rollout evidence" },
		)).toBe("/documents/acme%20space/docs%2Ftools/rollout%20evidence");
	});

	it("keeps one Project creating while another creation settles", () => {
		let creating = beginProjectCreation(new Set(), "R_one");
		creating = beginProjectCreation(creating, "R_two");

		expect([...finishProjectCreation(creating, "R_one")]).toEqual(["R_two"]);
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
