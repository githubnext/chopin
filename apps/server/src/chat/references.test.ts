import { describe, expect, it } from "bun:test";

import { ulid } from "@chopin/dialect";
import { childDocumentPath, documentPath } from "@chopin/protocol/document-url";

import { ReferenceService, restoreReferences } from "./references";
import { sourceHash } from "../plan/service";
import { MemoryStorage } from "../storage/memory/adapter";

import type { Chat as Wire, Job, Research } from "@chopin/protocol";
import type { DocumentTarget } from "../plan/service";
import type { ResearchWorkspaceService, ResearchWorkspaceView } from "../research/service";

let NOW = new Date("2026-08-23T12:00:00.000Z");
let ULID_SHAPE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function researchReferencePath(
	owner: string,
	repository: string,
	slug: string,
	workspaceId: string,
): string {
	return `/documents/${owner}/${repository}/${slug}/research/${workspaceId}`;
}

async function setup() {
	let storage = new MemoryStorage();
	await storage.users.put({ id: "U_test", login: "test", avatarUrl: "", now: NOW });
	let parent = await storage.channels.create({
		id: crypto.randomUUID(),
		repositoryId: "R_same",
		repositoryOwner: "octo-org",
		repositoryName: "score",
		title: "Current",
		createdBy: "U_test",
		now: NOW,
	});
	let target = await storage.channels.create({
		id: crypto.randomUUID(),
		repositoryId: "R_same",
		repositoryOwner: "octo-org",
		repositoryName: "score",
		title: "Release Notes",
		createdBy: "U_test",
		now: NOW,
	});
	let current = new Map<string, DocumentTarget>([[target.id, {
		channelId: target.id,
		revision: 3,
		source: "Release source.\n",
		sourceHash: sourceHash("Release source.\n"),
	}]]);
	let lease = await storage.leases.acquire("writer", "references", 60_000);
	if (!lease) throw new Error("writer lease unavailable");
	let storedWorkspace = await storage.research.create({
		id: "workspace-1",
		channelId: parent.id,
		title: "Release Research",
		proposedQuestion: "What changed?",
		origin: "planner",
		originMessageId: "origin-message",
		createdBy: "U_test",
		idempotencyKey: "references-test",
		fingerprint: "references-test",
		now: NOW,
		lease,
	});
	let workspace = researchView(parent.id, storedWorkspace.workspace.revision);
	let researchReads = 0;
	let research = {
		async read(channelId: string, workspaceId: string) {
			researchReads++;
			return channelId === parent.id && workspaceId === workspace.workspace.id
				? workspace
				: undefined;
		},
	} as ResearchWorkspaceService;
	let service = new ReferenceService({
		storage,
		current: async id => current.get(id),
		research,
		id: ulid,
	});
	return {
		current,
		parent,
		service,
		storage,
		target,
		workspace,
		get researchReads() {
			return researchReads;
		},
		setWorkspaceRevision(revision: number) {
			workspace = { ...workspace, workspace: { ...workspace.workspace, revision } };
		},
	};
}

function job(type: string, state: Job.State, value?: Job.Artifact["value"]): Job.Detail {
	return {
		revision: 4,
		currentTargetGeneration: 1,
		job: {
			id: `${type}-job`,
			type,
			version: 1,
			origin: "user",
			targetKey: `${type}:workspace`,
			targetGeneration: 1,
			state,
			revision: 4,
			attempts: 1,
			failures: 0,
			availableAt: NOW.toISOString(),
			reason: "raw-provider-reason",
			progress: [{
				revision: 1,
				attempt: 1,
				stage: "tool-event",
				label: "tool-event",
				state: "completed",
				reason: "raw-tool-reason",
				createdAt: NOW.toISOString(),
			}],
			createdAt: NOW.toISOString(),
			updatedAt: NOW.toISOString(),
		},
		...(value
			? { artifact: { revision: 1, value, createdAt: NOW.toISOString() } }
			: {}),
	};
}

function researchView(channelId: string, revision: number): ResearchWorkspaceView {
	let workspaceId = "workspace-1";
	let turnId = "turn-1";
	let source = { title: "Evidence", url: "https://example.com/evidence" };
	let evidence = job("research-evidence", "completed", {
		workspaceId,
		turnId,
		query: "What changed?",
		findings: ["A public finding."],
		sources: [source],
		model: "MODEL-MUST-NOT-LEAK",
	});
	let answer = job("research-answer", "completed", {
		workspaceId,
		turnId,
		kind: "initial",
		documentRevision: 2,
		documentSourceHash: sourceHash("Parent source.\n"),
		model: "MODEL-MUST-NOT-LEAK",
		report: {
			title: "Research report",
			summary: "The answer.",
			findings: [{ text: "A public finding.", sourceUrls: [source.url] }],
			caveats: [],
		},
		sources: [source],
		publicFindings: ["A public finding."],
		privateFindings: ["PRIVATE-MUST-NOT-LEAK"],
	});
	let workspace: Research.WorkspaceSummary = {
		id: workspaceId,
		channelId,
		title: "Release Research",
		proposedQuestion: "What changed?",
		confirmedQuery: "What changed in public releases?",
		origin: "planner",
		originMessageId: "PRIVATE-ORIGIN-MESSAGE",
		createdBy: "PRIVATE-CREATOR-ID",
		confirmedBy: "PRIVATE-CONFIRMER-ID",
		revision,
		createdAt: NOW.toISOString(),
		updatedAt: NOW.toISOString(),
	};
	let messages: Research.Message[] = [{
		id: "system-secret",
		workspaceId,
		sequence: 0,
		authorKind: "system",
		text: "SYSTEM-MUST-NOT-LEAK",
		createdAt: NOW.toISOString(),
	}];
	for (let index = 1; index <= 105; index++) {
		messages.push({
			id: `message-${index}`,
			workspaceId,
			sequence: index,
			turnId,
			authorKind: index % 2 ? "member" : "agent",
			userId: `PRIVATE-USER-${index}`,
			userHandle: index % 2 ? "ana" : undefined,
			text: `message ${index}`,
			sourceJobId: `PRIVATE-JOB-${index}`,
			createdAt: NOW.toISOString(),
		});
	}
	let turns: ResearchWorkspaceView["turns"] = [
		{
			id: turnId,
			workspaceId,
			ordinal: 0,
			kind: "initial",
			question: "What changed?",
			requestedBy: "PRIVATE-REQUESTER-ID",
			evidenceJobId: "PRIVATE-EVIDENCE-JOB",
			answerJobId: "PRIVATE-ANSWER-JOB",
			createdAt: NOW.toISOString(),
			updatedAt: NOW.toISOString(),
			evidence,
			answer,
		},
		...Array.from({ length: 20 }, (_, index) => ({
			id: `turn-${index + 2}`,
			workspaceId,
			ordinal: index + 1,
			kind: "follow-up" as const,
			question: `Follow-up ${index + 1}`,
			requestedBy: `PRIVATE-REQUESTER-${index + 1}`,
			createdAt: NOW.toISOString(),
			updatedAt: NOW.toISOString(),
		})),
	];
	return {
		workspace,
		turns,
		messages,
	};
}

function documentRequest(channelId: string, start = 0, end = 7): Wire.ReferenceRequest {
	return { kind: "document", channelId, start, end };
}

describe("chat reference requests", () => {
	it("requires sorted, disjoint, bounded UTF-16 token ranges", async () => {
		let { service, parent, target } = await setup();
		let resolve = (text: string, requests: unknown) =>
			service.resolve({
				channelId: parent.id,
				repositoryId: parent.repositoryId,
				text,
				destination: "room",
				requests: requests as Wire.ReferenceRequest[],
			});

		await expect(resolve("#target", [{ ...documentRequest(target.id), start: 0.5 }])).rejects
			.toThrow("range");
		await expect(resolve("#target", [{ ...documentRequest(target.id), end: 99 }])).rejects
			.toThrow("range");
		await expect(resolve("target", [documentRequest(target.id, 0, 6)])).rejects
			.toThrow("token");
		await expect(resolve(`#${"x".repeat(256)}`, [documentRequest(target.id, 0, 257)])).rejects
			.toThrow("range");
		await expect(resolve("#one #two", [
			documentRequest(target.id, 5, 9),
			{ kind: "research", workspaceId: "workspace-1", start: 0, end: 4 },
		])).rejects.toThrow("sorted");
		await expect(resolve("#one #two", [
			documentRequest(target.id, 0, 6),
			{ kind: "research", workspaceId: "workspace-1", start: 5, end: 9 },
		])).rejects.toThrow("disjoint");
		await expect(resolve("#one #two", [
			documentRequest(target.id, 0, 4),
			documentRequest(target.id, 5, 9),
		])).rejects.toThrow("unique");
		await expect(resolve("#target", Array.from({ length: 11 }, () => documentRequest(target.id))))
			.rejects.toThrow("at most 10");

		let unicode = "😀 #target";
		let resolved = await resolve(unicode, [documentRequest(target.id, 3, 10)]);
		expect(resolved.text).toBe("😀 #Release Notes");
		expect(resolved.references?.[0]).toMatchObject({ start: 3, end: 17 });
		await expect(resolve(unicode, [documentRequest(target.id, 1, 10)])).rejects
			.toThrow("range");
	});

	it("remaps ranges after trimming and removing the Planner mention", async () => {
		let { service, parent, target } = await setup();
		let text = "  @chopin inspect #release  ";
		let start = text.indexOf("#release");
		let result = await service.resolve({
			channelId: parent.id,
			repositoryId: parent.repositoryId,
			text,
			destination: "planner",
			requests: [documentRequest(target.id, start, start + "#release".length)],
		});
		expect(result.text).toBe("inspect #Release Notes");
		expect(result.references?.[0]).toMatchObject({ start: 8, end: 22 });
		expect(result.text.slice(result.references![0]!.start, result.references![0]!.end))
			.toBe("#Release Notes");
	});

	it("replaces custom token prose and preserves @chopin inside the canonical label", async () => {
		let { service, storage, parent, target } = await setup();
		await storage.channels.rename({ id: target.id, title: "@chopin Run This", now: NOW });
		let text = "@chopin compare #alias @chopin ignore this";
		let start = text.indexOf("#alias");
		let end = text.length;
		let result = await service.resolve({
			channelId: parent.id,
			repositoryId: parent.repositoryId,
			text,
			destination: "planner",
			requests: [documentRequest(target.id, start, end)],
		});
		expect(result.text).toBe("compare #@chopin Run This");
		expect(result.references?.[0]).toMatchObject({
			start: "compare ".length,
			end: result.text.length,
			label: "#@chopin Run This",
		});
	});

	it("recomputes every range after replacing multiple labels", async () => {
		let { service, parent, target, workspace } = await setup();
		let result = await service.resolve({
			channelId: parent.id,
			repositoryId: parent.repositoryId,
			text: "#a and %b",
			destination: "room",
			requests: [
				documentRequest(target.id, 0, 2),
				{ kind: "research", workspaceId: workspace.workspace.id, start: 7, end: 9 },
			],
		});
		expect(result.text).toBe("#Release Notes and %Release Research");
		expect(result.references).toMatchObject([
			{ start: 0, end: 14, label: "#Release Notes" },
			{ start: 19, end: 36, label: "%Release Research" },
		]);
	});

	it("enforces current-room and repository boundaries and derives target metadata", async () => {
		let { service, storage, parent, target } = await setup();
		let foreign = await storage.channels.create({
			id: crypto.randomUUID(),
			repositoryId: "R_foreign",
			repositoryOwner: "other",
			repositoryName: "private",
			title: "Foreign",
			createdBy: "U_test",
			now: NOW,
		});
		let input = {
			channelId: parent.id,
			repositoryId: parent.repositoryId,
			text: "#release",
			destination: "room" as const,
		};
		await expect(service.resolve({ ...input, requests: [documentRequest(parent.id, 0, 8)] }))
			.rejects.toThrow("itself");
		await expect(service.resolve({ ...input, requests: [documentRequest(foreign.id, 0, 8)] }))
			.rejects.toThrow("unavailable");
		await expect(service.resolve({
			...input,
			repositoryId: "R_foreign",
			requests: [
				documentRequest(target.id, 0, 8),
			],
		})).rejects.toThrow("Current document");

		let result = await service.resolve({ ...input, requests: [documentRequest(target.id, 0, 8)] });
		expect(result.text).toBe("#Release Notes");
		expect(result.references?.[0]).toMatchObject({
			kind: "document",
			channelId: target.id,
			label: "#Release Notes",
			href: documentPath("octo-org", "score", target.slug),
			repositoryId: "R_same",
			observedRevision: 3,
			observedSourceHash: sourceHash("Release source.\n"),
		});
		let metadataOnly = await storage.channels.create({
			id: crypto.randomUUID(),
			repositoryId: parent.repositoryId,
			repositoryOwner: parent.repositoryOwner,
			repositoryName: parent.repositoryName,
			title: "Empty",
			createdBy: "U_test",
			now: NOW,
		});
		let empty = await service.resolve({
			...input,
			text: "#empty",
			requests: [documentRequest(metadataOnly.id, 0, 6)],
		});
		expect(empty.references?.[0]).toMatchObject({
			observedRevision: 0,
			observedSourceHash: sourceHash(""),
		});
	});

	it("uses the canonical nested URL for ordinary child documents", async () => {
		let { current, service, storage, parent } = await setup();
		let child = await storage.channels.create({
			id: crypto.randomUUID(),
			repositoryId: parent.repositoryId,
			repositoryOwner: parent.repositoryOwner,
			repositoryName: parent.repositoryName,
			parentChannelId: parent.id,
			title: "Source Review",
			createdBy: "U_test",
			now: NOW,
		});
		current.set(child.id, {
			channelId: child.id,
			revision: 1,
			source: "Child source.\n",
			sourceHash: sourceHash("Child source.\n"),
		});

		let resolved = await service.resolve({
			channelId: parent.id,
			repositoryId: parent.repositoryId,
			text: "#source",
			destination: "room",
			requests: [documentRequest(child.id, 0, 7)],
		});
		let href = childDocumentPath(
			parent.repositoryOwner,
			parent.repositoryName,
			parent.slug,
			child.slug,
		);
		expect(resolved.references?.[0]).toMatchObject({ href });
		expect(
			await service.read({
				channelId: parent.id,
				repositoryId: parent.repositoryId,
				reference: resolved.references![0]!,
			}),
		).toMatchObject({ href });
	});
});

async function yes() {
	return true;
}

function request(name: string, commandKind: string, start: number, end: number) {
	return { kind: "command", name, commandKind, start, end };
}

describe("chat command requests", () => {
	let commands: Wire.CommandOption[] = [
		{ name: "skill:notes", kind: "skill", description: "Take notes" },
		{ name: "review", kind: "prompt" },
		{ name: "review", kind: "workflow" },
	];
	let run = async (
		text: string,
		requests: unknown[],
		reported: Wire.CommandOption[] | null = commands,
		destination: Wire.Destination = "planner",
	) => {
		let { service, parent } = await setup();
		return service.resolve({
			channelId: parent.id,
			repositoryId: parent.repositoryId,
			text,
			destination,
			requests: requests as Wire.ReferenceRequest[],
			...(reported ? { commands: reported } : {}),
		});
	};
	it("keeps the command's token as the opening of the message, with its name and kind", async () => {
		let result = await run("@chopin /skill:notes for today", [
			request("skill:notes", "skill", 8, 20),
		]);
		expect(result.text).toBe("/skill:notes for today");
		expect(result.references).toEqual([{
			kind: "command",
			id: expect.stringMatching(ULID_SHAPE),
			start: 0,
			end: 12,
			label: "/skill:notes",
			name: "skill:notes",
			commandKind: "skill",
		}]);
	});

	it("tells two commands that share a name apart by their kind", async () => {
		let prompt = await run("/review the diff", [request("review", "prompt", 0, 7)]);
		let workflow = await run("/review the diff", [request("review", "workflow", 0, 7)]);
		expect(prompt.references?.[0]).toMatchObject({ name: "review", commandKind: "prompt" });
		expect(workflow.references?.[0]).toMatchObject({ name: "review", commandKind: "workflow" });
		await expect(run("/review", [request("review", "skill", 0, 7)])).rejects.toThrow(
			"/review is not one of the commands the Planner offers",
		);
	});

	it("refuses a command the Planner does not report, in words a person can read", async () => {
		await expect(run("/ship it", [request("ship", "workflow", 0, 5)])).rejects.toMatchObject({
			name: "ChatCommandError",
			message: "/ship is not one of the commands the Planner offers.",
		});
		await expect(run("/Review", [request("Review", "prompt", 0, 7)])).rejects.toThrow(
			"/Review is not one of the commands the Planner offers",
		);
	});

	it("refuses every command while the Planner has reported none, and says so", async () => {
		let said = "The Planner has not reported any commands, so /review cannot run.";
		await expect(run("/review", [request("review", "prompt", 0, 7)], null)).rejects
			.toMatchObject({ name: "ChatCommandError", message: said });
		await expect(run("/review", [request("review", "prompt", 0, 7)], [])).rejects
			.toMatchObject({ message: said });
	});

	it("takes a command only at the start of a message to the Planner, once", async () => {
		await expect(run("please /review", [request("review", "prompt", 7, 14)])).rejects.toThrow(
			"A command has to open the message.",
		);
		await expect(run("/review the diff", [request("review", "prompt", 0, 7)], commands, "room"))
			.rejects.toThrow("A command runs in the Planner's turn");
		await expect(run("/review /skill:notes", [
			request("review", "prompt", 0, 7),
			request("skill:notes", "skill", 8, 20),
		])).rejects.toThrow("A message can run one command.");
	});

	it("keeps the command's chip when other references follow it", async () => {
		let { service, parent, target } = await setup();
		let result = await service.resolve({
			channelId: parent.id,
			repositoryId: parent.repositoryId,
			text: "/review #notes",
			destination: "planner",
			requests: [
				request("review", "prompt", 0, 7),
				documentRequest(target.id, 8, 14),
			] as Wire.ReferenceRequest[],
			commands,
		});
		expect(result.text).toBe("/review #Release Notes");
		expect(result.references?.map(reference => reference.kind)).toEqual(["command", "document"]);
	});
});

const MENTION_SOURCE = [
	"# Overview",
	"",
	"## Site 1: harbour survey",
	"",
	'<Questionnaire id="01HQ0000000000000000000000">',
	'<Question id="q1" header="Rollout" prompt="How should we deploy?" multiple="false">',
	'<Option id="o1" label="Canary" />',
	"</Question>",
	"</Questionnaire>",
	"",
	'<Research id="workspace-1" />',
	"",
].join("\n");

describe("chat mention requests", () => {
	async function mentioned(
		text: string,
		requests: unknown[],
		files?: (path: string) => Promise<boolean | undefined>,
		destination: Wire.Destination = "planner",
	) {
		let { service, parent, current } = await setup();
		current.set(parent.id, {
			channelId: parent.id,
			revision: 5,
			source: MENTION_SOURCE,
			sourceHash: sourceHash(MENTION_SOURCE),
		});
		return service.resolve({
			channelId: parent.id,
			repositoryId: parent.repositoryId,
			text,
			destination,
			requests: requests as Wire.ReferenceRequest[],
			...(files ? { fileExists: files } : {}),
		});
	}

	it("points at a heading by its anchor, and shows its words as the document has them now", async () => {
		let result = await mentioned("Rewrite @site first", [
			{ kind: "heading", anchor: "site-1-harbour-survey", start: 8, end: 13 },
		]);
		expect(result.text).toBe("Rewrite @Site 1: harbour survey first");
		expect(result.references).toEqual([{
			kind: "heading",
			id: expect.stringMatching(ULID_SHAPE),
			start: 8,
			end: 31,
			label: "@Site 1: harbour survey",
			anchor: "site-1-harbour-survey",
			level: 2,
			line: 3,
		}]);
	});

	it("points at a Decision by its id, shown by its header", async () => {
		let result = await mentioned("What about @roll", [
			{ kind: "decision", decisionId: "01HQ0000000000000000000000", start: 11, end: 16 },
		]);
		expect(result.text).toBe("What about @Rollout");
		expect(result.references?.[0]).toMatchObject({
			kind: "decision",
			decisionId: "01HQ0000000000000000000000",
			label: "@Rollout",
		});
	});

	it("points at a research card of this document by its workspace, as a research reference", async () => {
		let result = await mentioned("See %rel", [
			{ kind: "research", workspaceId: "workspace-1", start: 4, end: 8 },
		]);
		expect(result.text).toBe("See %Release Research");
		expect(result.references?.[0]).toMatchObject({ kind: "research", workspaceId: "workspace-1" });
	});

	it("points at a file by its path, where the repository's files can say it is there", async () => {
		let result = await mentioned("Look at @index", [
			{ kind: "file", path: "src/index.ts", start: 8, end: 14 },
		], async path => path === "src/index.ts");
		expect(result.text).toBe("Look at @src/index.ts");
		expect(result.references?.[0]).toMatchObject({
			kind: "file",
			path: "src/index.ts",
			label: "@src/index.ts",
		});
	});

	it("refuses a part the document no longer has, in words a person can read", async () => {
		await expect(mentioned("@gone", [{ kind: "heading", anchor: "gone", start: 0, end: 5 }]))
			.rejects.toMatchObject({
				name: "ChatMentionError",
				message: "That heading is no longer in the document.",
			});
		await expect(mentioned("@gone", [{ kind: "decision", decisionId: "nope", start: 0, end: 5 }]))
			.rejects.toMatchObject({ message: "That Decision is no longer in the document." });
		await expect(
			mentioned("@a.ts", [{ kind: "file", path: "a.ts", start: 0, end: 5 }], async () => false),
		).rejects.toMatchObject({ message: "That file is not in the repository." });
		await expect(
			mentioned("@a.ts", [{ kind: "file", path: "a.ts", start: 0, end: 5 }], async () => undefined),
		).rejects.toMatchObject({
			message: "This repository's files cannot be listed right now, so a file cannot be mentioned.",
		});
		await expect(mentioned("@a.ts", [{ kind: "file", path: "a.ts", start: 0, end: 5 }]))
			.rejects.toMatchObject({ name: "ChatMentionError" });
	});

	it("takes a path only as a plain relative one from the repository's root", async () => {
		for (let path of ["../secret", "/etc/passwd", "a//b", "a\\b", "a/./b", "", "x/..", "a\nb"]) {
			await expect(
				mentioned("@x", [{ kind: "file", path, start: 0, end: 2 }], yes),
			).rejects.toThrow();
		}
		await expect(
			mentioned("@x", [{ kind: "file", path: "x".repeat(200), start: 0, end: 2 }], yes),
		).rejects.toMatchObject({ message: "That path is too long to mention." });
	});

	it("mixes every kind in one message and keeps each range, a part once", async () => {
		let result = await mentioned("@a and @b and @c", [
			{ kind: "heading", anchor: "overview", start: 0, end: 2 },
			{ kind: "decision", decisionId: "01HQ0000000000000000000000", start: 7, end: 9 },
			{ kind: "file", path: "README.md", start: 14, end: 16 },
		], async () => true);
		expect(result.text).toBe("@Overview and @Rollout and @README.md");
		expect(result.references?.map(reference => reference.kind)).toEqual([
			"heading",
			"decision",
			"file",
		]);
		await expect(mentioned("@a @b", [
			{ kind: "heading", anchor: "overview", start: 0, end: 2 },
			{ kind: "heading", anchor: "overview", start: 3, end: 5 },
		])).rejects.toThrow("unique");
	});
});

describe("reading cached reference targets", () => {
	it("uses latest document metadata and reports source drift without retargeting", async () => {
		let { current, service, storage, parent, target } = await setup();
		let resolved = await service.resolve({
			channelId: parent.id,
			repositoryId: parent.repositoryId,
			text: "#release",
			destination: "room",
			requests: [documentRequest(target.id, 0, 8)],
		});
		let reference = resolved.references![0]!;
		await storage.channels.rename({ id: target.id, title: "Launch Notes", now: NOW });
		let renamed = await service.read({
			channelId: parent.id,
			repositoryId: parent.repositoryId,
			reference,
		}) as Record<string, unknown>;
		expect(renamed).toMatchObject({
			label: "#Release Notes",
			title: "Launch Notes",
			href: documentPath("octo-org", "score", "launch-notes"),
			changedSinceReference: false,
		});

		current.set(target.id, {
			channelId: target.id,
			revision: 4,
			source: "Changed source.\n",
			sourceHash: sourceHash("Changed source.\n"),
		});
		let changed = await service.read({
			channelId: parent.id,
			repositoryId: parent.repositoryId,
			reference,
		}) as Record<string, unknown>;
		expect(changed).toMatchObject({
			observedRevision: 3,
			currentRevision: 4,
			changedSinceReference: true,
			source: "Changed source.\n",
		});
		await expect(service.read({
			channelId: parent.id,
			repositoryId: "R_other",
			reference,
		})).rejects.toThrow("unavailable");
		let get = storage.channels.get;
		storage.channels.get = async id =>
			id === target.id ? { ...target, repositoryId: "R_moved" } : get(id);
		await expect(service.read({
			channelId: parent.id,
			repositoryId: parent.repositoryId,
			reference,
		})).rejects.toThrow("moved or is unavailable");
	});

	it("returns a sanitized, bounded whole-workspace research projection", async () => {
		let context = await setup();
		let { service, parent, target, workspace, setWorkspaceRevision } = context;
		let text = "%research";
		let resolved = await service.resolve({
			channelId: parent.id,
			repositoryId: parent.repositoryId,
			text,
			destination: "planner",
			requests: [{
				kind: "research",
				workspaceId: workspace.workspace.id,
				start: 0,
				end: text.length,
			}],
		});
		let reference = resolved.references![0]!;
		expect(context.researchReads).toBe(0);
		expect(reference).toMatchObject({
			kind: "research",
			parentChannelId: parent.id,
			label: "%Release Research",
			href: researchReferencePath(
				parent.repositoryOwner,
				parent.repositoryName,
				parent.slug,
				workspace.workspace.id,
			),
			observedRevision: workspace.workspace.revision,
		});

		setWorkspaceRevision(workspace.workspace.revision + 1);
		let read = await service.read({
			channelId: parent.id,
			repositoryId: parent.repositoryId,
			reference,
		}) as {
			changedSinceReference: boolean;
			messages: unknown[];
			turns: Array<Record<string, unknown>>;
			truncation: {
				turns: { total: number; returned: number; truncated: boolean; byteLimit: number };
				messages: { total: number; returned: number; truncated: boolean; byteLimit: number };
			};
		};
		expect(context.researchReads).toBe(1);
		expect(read.changedSinceReference).toBe(true);
		expect(read.messages).toHaveLength(100);
		expect(read.turns).toHaveLength(12);
		expect(read.turns[0]).toMatchObject({
			question: "What changed?",
			states: { evidence: "completed", answer: "completed" },
			evidence: { findings: ["A public finding."] },
			answer: { kind: "initial", report: { summary: "The answer." } },
		});
		expect(read.turns.at(-1)).toMatchObject({ ordinal: 20, question: "Follow-up 20" });
		expect(read.truncation).toMatchObject({
			turns: { total: 21, returned: 12, truncated: true },
			messages: { total: 105, returned: 100, truncated: true },
		});
		expect(read.turns.reduce(
			(total, turn) => total + Buffer.byteLength(JSON.stringify(turn)),
			0,
		)).toBeLessThanOrEqual(read.truncation.turns.byteLimit);
		expect(Buffer.byteLength(JSON.stringify(read.messages)))
			.toBeLessThanOrEqual(read.truncation.messages.byteLimit);
		let serialized = JSON.stringify(read);
		for (
			let secret of [
				"PRIVATE-MUST-NOT-LEAK",
				"PRIVATE-CREATOR-ID",
				"PRIVATE-CONFIRMER-ID",
				"PRIVATE-ORIGIN-MESSAGE",
				"PRIVATE-REQUESTER-ID",
				"PRIVATE-JOB-105",
				"MODEL-MUST-NOT-LEAK",
				"raw-provider-reason",
				"raw-tool-reason",
				"tool-event",
				"SYSTEM-MUST-NOT-LEAK",
			]
		) expect(serialized).not.toContain(secret);
		await expect(service.read({
			channelId: target.id,
			repositoryId: target.repositoryId,
			reference,
		})).rejects.toThrow("moved");
	});
});

describe("stored mentions", () => {
	let id = ulid();
	let heading: Wire.HeadingReference = {
		kind: "heading",
		id,
		start: 0,
		end: 9,
		label: "@Overview",
		anchor: "overview",
		level: 1,
		line: 1,
	};
	let decision: Wire.DecisionReference = {
		kind: "decision",
		id: ulid(),
		start: 10,
		end: 18,
		label: "@Rollout",
		decisionId: "01HQ0000000000000000000000",
	};
	let file: Wire.FileReference = {
		kind: "file",
		id: ulid(),
		start: 19,
		end: 32,
		label: "@src/index.ts",
		path: "src/index.ts",
	};
	let command: Wire.CommandReference = {
		kind: "command",
		id: ulid(),
		start: 33,
		end: 40,
		label: "/review",
		name: "review",
		commandKind: "prompt",
	};
	let text = "@Overview @Rollout @src/index.ts /review";

	it("are restored exactly as kept, for every kind in one message", () => {
		let all = [heading, decision, file, command];
		expect(restoreReferences(all, text)).toEqual(all);
	});

	it("are refused when their shape, range, label or identity drifts", () => {
		for (
			let invalid of [
				{ ...heading, extra: true },
				{ ...heading, level: 7 },
				{ ...heading, line: 0 },
				{ ...heading, anchor: 3 },
				{ ...heading, label: "Overview" },
				{ ...decision, decisionId: undefined },
				{ ...file, label: "@src/other.ts" },
				{ ...file, id: "not-a-server-id" },
				{ ...command, label: "/other" },
				{ ...heading, end: 8 },
			]
		) expect(() => restoreReferences([invalid], text)).toThrow();
		expect(() => restoreReferences([heading, { ...heading, id: ulid(), start: 0, end: 9 }], text))
			.toThrow();
	});

	it("name no address, so none is read by id", async () => {
		let { service, parent } = await setup();
		for (let reference of [heading, decision, file, command]) {
			await expect(service.read({
				channelId: parent.id,
				repositoryId: parent.repositoryId,
				reference,
			})).rejects.toThrow("not read by id");
		}
	});
});

describe("stored references", () => {
	it("accepts the exact persisted shape and rejects shape, hash, URL, and range drift", () => {
		let channelId = crypto.randomUUID();
		let reference: Wire.DocumentReference = {
			id: ulid(),
			kind: "document",
			start: 0,
			end: 7,
			label: "#Target",
			href: "/documents/octo-org/score/target",
			repositoryId: "R_same",
			observedRevision: 2,
			channelId,
			observedSourceHash: sourceHash("Target.\n"),
		};
		expect(restoreReferences([reference], "#Target")).toEqual([reference]);
		for (
			let invalid of [
				{ ...reference, extra: true },
				{ ...reference, observedSourceHash: "sha256:nope" },
				{ ...reference, href: `${reference.href}?stale=1` },
				{ ...reference, end: 8 },
				{ ...reference, id: "not-a-server-id" },
				{ ...reference, id: { toString: () => reference.id } },
			]
		) expect(() => restoreReferences([invalid], "#Target")).toThrow();
		expect(() => restoreReferences([reference], "#target")).toThrow("does not match");
		expect(restoreReferences([reference], "#Target", new Set(), {
			channelId: crypto.randomUUID(),
			repositoryId: "R_same",
		})).toEqual([reference]);
		expect(() =>
			restoreReferences([reference], "#Target", new Set(), {
				channelId: reference.channelId,
				repositoryId: "R_same",
			})
		).toThrow("outside its parent");
		expect(() =>
			restoreReferences([reference], "#Target", new Set(), {
				channelId: crypto.randomUUID(),
				repositoryId: "R_other",
			})
		).toThrow("outside its parent");
	});
});
