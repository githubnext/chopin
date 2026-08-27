import { createHash } from "node:crypto";
import { expect } from "bun:test";

import { JobRegistry } from "../jobs/registry";
import {
	parseResearchAnswerInput,
	parseResearchEvidenceInput,
	researchAnswerDefinition,
	researchEvidenceDefinition,
} from "../jobs/research-workspace";
import { JobService } from "../jobs/service";
import { MemoryStorage } from "../storage/memory/adapter";
import { ResearchWorkspaceService } from "./service";

import type { ResearchReport } from "../jobs/research-workspace";
import type { BackgroundJob, JsonValue } from "../storage/model";

const SOURCE = "# Parent document\n\nThe private compatibility plan is current.\n";
const SOURCE_HASH = `sha256:${createHash("sha256").update(SOURCE).digest("hex")}`;
export const USER_ID = "MDQ6VXNlcjU0MjcwODM=";
export const REPOSITORY_ID = "MDEwOlJlcG9zaXRvcnkxMjM=";
export const PUBLIC_SOURCE = {
	title: "Release notes",
	url: "https://example.com/releases/v3",
};
export const REPORT: ResearchReport = {
	title: "Compatibility report",
	summary: "The public and private evidence indicate compatibility.",
	findings: [{ text: "Compatibility was retained.", sourceUrls: [PUBLIC_SOURCE.url] }],
	caveats: ["Only the supplied release notes were reviewed."],
};

export function requestId(value: number): string {
	return `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
}

export async function setup(options: { answer?: boolean; evidence?: boolean } = {}) {
	let now = new Date("2026-08-23T12:00:00.000Z");
	let storage = new MemoryStorage();
	let userId = USER_ID;
	let channelId = crypto.randomUUID();
	await storage.users.put({ id: userId, login: "octocat", avatarUrl: "avatar", now });
	await storage.channels.create({
		id: channelId,
		repositoryId: REPOSITORY_ID,
		repositoryOwner: "octo-org",
		repositoryName: "score",
		title: "Release plan",
		createdBy: userId,
		now,
	});
	let lease = await storage.leases.acquire("chopin:writer", "test-writer", 60_000);
	if (!lease) throw new Error("writer lease unavailable");
	let definitions = [];
	if (options.evidence !== false) {
		definitions.push(researchEvidenceDefinition({
			config: { agent: true, model: "research-model" },
			engine: async () => ({ findings: [], sources: [] }),
		}));
	}
	if (options.answer !== false) {
		definitions.push(researchAnswerDefinition({
			config: { agent: true, model: "research-model" },
			engines: {
				private: async () => ({ findings: [] }),
				synthesize: async () => REPORT,
				answer: async () => ({ text: "Answer", sourceUrls: [] }),
			},
		}));
	}
	let registry = new JobRegistry(definitions);
	let jobSequence = 0;
	let jobs = new JobService({
		storage,
		registry,
		lease: () => lease,
		now: () => now,
		id: () => `job-${++jobSequence}`,
	});
	let entitySequence = 0;
	let publications: Array<{ workspaceId: string; revision: number }> = [];
	let service = () =>
		new ResearchWorkspaceService({
			storage,
			jobs,
			lease: () => lease,
			clock: () => now,
			id: () => `entity-${++entitySequence}`,
			current: async requestedChannelId => ({
				channelId: requestedChannelId,
				revision: 7,
				source: SOURCE,
				sourceHash: SOURCE_HASH,
			}),
			publish: async (publishedChannelId, workspaceId, revision) => {
				let durable = await storage.research.get(publishedChannelId, workspaceId);
				expect(durable?.workspace.revision).toBe(revision);
				publications.push({ workspaceId, revision });
			},
		});
	let advance = () => {
		now = new Date(now.getTime() + 1);
		return now;
	};
	return {
		storage,
		service: service(),
		restart: service,
		jobs,
		lease,
		channelId,
		userId,
		publications,
		advance,
	};
}

export type ResearchTestContext = Awaited<ReturnType<typeof setup>>;

export async function settle(
	context: ResearchTestContext,
	type: "research-evidence" | "research-answer",
	artifact: (job: BackgroundJob) => JsonValue,
) {
	let claimed = await context.storage.jobs.claim({
		channelId: context.channelId,
		claimOwner: `worker-${type}`,
		count: 100,
		ttlMs: 30_000,
		now: context.advance(),
		lease: context.lease,
	});
	let job = claimed.find(value => value.type === type);
	if (!job) throw new Error(`no pending ${type} job`);
	return context.jobs.settle({
		channelId: job.channelId,
		jobId: job.id,
		claimOwner: job.claimOwner!,
		claimGeneration: job.claimGeneration,
		artifact: artifact(job),
	});
}

export async function reconciledRequest(
	service: ResearchWorkspaceService,
	channelId: string,
	workspaceId: string,
) {
	expect(await service.reconcile(channelId, workspaceId)).toBe(true);
	return service.request(channelId, workspaceId);
}

export async function reconciledWorkspace(
	service: ResearchWorkspaceService,
	channelId: string,
	workspaceId: string,
) {
	expect(await service.reconcile(channelId, workspaceId)).toBe(true);
	return service.get(channelId, workspaceId);
}

export function evidenceArtifact(job: BackgroundJob): JsonValue {
	let input = parseResearchEvidenceInput(job.input);
	return {
		...input,
		findings: ["The public release notes retain compatibility."],
		sources: [PUBLIC_SOURCE],
		model: "research-model",
	};
}

export function answerArtifact(job: BackgroundJob, text = "The old client was tested."): JsonValue {
	let input = parseResearchAnswerInput(job.input);
	let basis = {
		workspaceId: input.workspaceId,
		turnId: input.turnId,
		kind: input.kind,
		documentRevision: input.document.revision,
		documentSourceHash: input.document.sourceHash,
		model: "research-model",
	};
	return input.kind === "initial"
		? {
			...basis,
			report: REPORT,
			sources: [PUBLIC_SOURCE],
			publicFindings: ["The public release notes retain compatibility."],
			privateFindings: ["The private plan is current."],
		}
		: {
			...basis,
			answer: { text, sourceUrls: [PUBLIC_SOURCE.url] },
			sources: [PUBLIC_SOURCE],
		};
}

export async function createAndConfirm(context: ResearchTestContext) {
	let created = await context.service.createDraft({
		channelId: context.channelId,
		question: "  Which API contracts changed?  ",
		requestId: requestId(1),
		origin: "sidebar",
		createdBy: context.userId,
	});
	let confirmed = await context.service.confirm({
		channelId: context.channelId,
		workspaceId: created.workspace.id,
		query: " Which API contracts changed? ",
		requestId: requestId(2),
		confirmedBy: context.userId,
		confirmedByHandle: "octocat",
	});
	return { created, confirmed };
}

export async function finishInitial(context: ResearchTestContext) {
	let created = await createAndConfirm(context);
	let evidence = await settle(context, "research-evidence", evidenceArtifact);
	await context.service.jobChanged(evidence.job);
	let answer = await settle(context, "research-answer", answerArtifact);
	await context.service.jobChanged(answer.job);
	return created;
}
