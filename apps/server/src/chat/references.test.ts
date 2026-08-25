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
