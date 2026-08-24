import { createHash } from "node:crypto";
import { describe, expect, it, spyOn } from "bun:test";

import { parse } from "@chopin/dialect";
import { JobRegistry } from "../jobs/registry";
import {
	parseResearchAnswerInput,
	parseResearchEvidenceInput,
	researchAnswerDefinition,
	researchEvidenceDefinition,
} from "../jobs/research-workspace";
import { JobService } from "../jobs/service";
import { StorageError } from "../storage/errors";
import { MemoryStorage } from "../storage/memory/adapter";
import * as Plan from "../plan/service";
import { boundedResearchEvidence, ResearchWorkspaceService } from "./service";

import type { BackgroundJob, JsonValue } from "../storage/model";
import type { ResearchReport } from "../jobs/research-workspace";

const SOURCE = "# Parent document\n\nThe private compatibility plan is current.\n";
const SOURCE_HASH = `sha256:${createHash("sha256").update(SOURCE).digest("hex")}`;
const USER_ID = "MDQ6VXNlcjU0MjcwODM=";
const REPOSITORY_ID = "MDEwOlJlcG9zaXRvcnkxMjM=";
const PUBLIC_SOURCE = { title: "Release notes", url: "https://example.com/releases/v3" };
const REPORT: ResearchReport = {
	title: "Compatibility report",
	summary: "The public and private evidence indicate compatibility.",
	findings: [{ text: "Compatibility was retained.", sourceUrls: [PUBLIC_SOURCE.url] }],
	caveats: ["Only the supplied release notes were reviewed."],
};

function requestId(value: number): string {
	return `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
}

async function setup(options: { answer?: boolean; evidence?: boolean } = {}) {
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

async function settle(
	context: Awaited<ReturnType<typeof setup>>,
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

function evidenceArtifact(job: BackgroundJob): JsonValue {
	let input = parseResearchEvidenceInput(job.input);
	return {
		...input,
		findings: ["The public release notes retain compatibility."],
		sources: [PUBLIC_SOURCE],
		model: "research-model",
	};
}

function answerArtifact(job: BackgroundJob, text = "The old client was tested."): JsonValue {
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

async function createAndConfirm(context: Awaited<ReturnType<typeof setup>>) {
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

async function finishInitial(context: Awaited<ReturnType<typeof setup>>) {
	let created = await createAndConfirm(context);
	let evidence = await settle(context, "research-evidence", evidenceArtifact);
	await context.service.jobChanged(evidence.job);
	let answer = await settle(context, "research-answer", answerArtifact);
	await context.service.jobChanged(answer.job);
	return created;
}

describe("research workspace service", () => {
	it("starts one inline request and schedules its initial turn immediately", async () => {
		let context = await setup();
		let brief = "  Compare API v2 with v3.\nExplain  migration risks.  ";
		let started = await context.service.start({
			channelId: context.channelId,
			question: brief,
			requestId: requestId(1),
			requestedBy: context.userId,
			requestedByHandle: "octocat",
		});

		expect(started).toMatchObject({
			repeated: false,
			request: {
				question: brief,
				state: "pending",
				stage: "queued",
				sources: [],
			},
		});
		let stored = await context.storage.research.get(
			context.channelId,
			started.request.id,
		);
		expect(stored).toMatchObject({
			workspace: {
				origin: "inline",
				proposedQuestion: brief,
				confirmedQuery: brief,
				createdBy: USER_ID,
				confirmedBy: USER_ID,
			},
			turns: [{ kind: "initial", question: brief, requestedBy: USER_ID }],
			messages: [{ authorKind: "member", text: brief, userHandle: "octocat" }],
		});
		expect(stored?.turns[0]?.evidenceJobId).toBeDefined();

		let repeated = await context.service.start({
			channelId: context.channelId,
			question: brief,
			requestId: requestId(1),
			requestedBy: context.userId,
			requestedByHandle: "octocat",
		});
		expect(repeated).toEqual({ ...started, repeated: true });
		await expect(context.service.start({
			channelId: context.channelId,
			question: "A different brief",
			requestId: requestId(1),
			requestedBy: context.userId,
			requestedByHandle: "octocat",
		})).rejects.toBeInstanceOf(StorageError);
	});

	it("starts Planner research immediately and replays its member message identity", async () => {
		let context = await setup();
		let owners = 0;
		let input = {
			channelId: context.channelId,
			question: "Which public evidence supports version 3?",
			originMessageId: "01K39QZG000000000000000001",
			requestedBy: context.userId,
			requestedByHandle: "octocat",
			beforeStart: () => {
				owners++;
			},
		};
		let started = await context.service.startPlanner(input);
		expect(started).toMatchObject({
			repeated: false,
			request: { state: "pending", stage: "queued" },
		});
		let stored = await context.storage.research.get(context.channelId, started.request.id);
		expect(stored).toMatchObject({
			workspace: {
				origin: "planner",
				originMessageId: input.originMessageId,
				confirmedQuery: input.question,
			},
			turns: [{ kind: "initial", question: input.question }],
		});
		expect(stored?.turns[0]?.evidenceJobId).toBeDefined();

		let repeated = await context.service.startPlanner({
			...input,
			beforeStart: () => {
				throw new Error("an active replay must not reacquire an owner");
			},
		});
		expect(repeated.repeated).toBe(true);
		expect(repeated.request.id).toBe(started.request.id);
		expect(owners).toBe(1);
	});

	it("checks durable work before owner setup and recovers setup failure before enqueue", async () => {
		let context = await setup();
		let brief = "Which API contracts changed?";
		let input = {
			channelId: context.channelId,
			question: brief,
			requestId: requestId(1),
			requestedBy: context.userId,
		};
		let owners = 0;
		let active = await context.service.start({
			...input,
			beforeStart: () => {
				owners++;
			},
		});
		await context.service.start({
			...input,
			beforeStart: () => {
				throw new Error("an active replay must not reacquire an owner");
			},
		});
		await settle(context, "research-evidence", evidenceArtifact);
		await context.service.request(context.channelId, active.request.id);
		await settle(context, "research-answer", answerArtifact);
		await context.service.request(context.channelId, active.request.id);
		await context.service.start({
			...input,
			beforeStart: () => {
				throw new Error("a completed replay must not reacquire an owner");
			},
		});
		expect(owners).toBe(1);

		let recovery = await setup();
		let attempts = 0;
		let recoveryInput = {
			channelId: recovery.channelId,
			question: brief,
			requestId: requestId(2),
			requestedBy: recovery.userId,
		};
		await expect(recovery.service.start({
			...recoveryInput,
			beforeStart: () => {
				attempts++;
				throw new Error("owner setup failed");
			},
		})).rejects.toThrow("owner setup failed");
		let durable = await recovery.storage.research.list(recovery.channelId, 100);
		expect(durable).toHaveLength(1);
		expect((await recovery.storage.research.get(recovery.channelId, durable[0]!.id))?.turns[0])
			.toMatchObject({ kind: "initial", evidenceJobId: undefined });
		let recovered = await recovery.service.start({
			...recoveryInput,
			beforeStart: () => {
				attempts++;
			},
		});
		expect(recovered.repeated).toBe(true);
		expect(recovered.request.stage).toBe("queued");
		expect(attempts).toBe(2);
	});

	it("runs owner setup once across concurrent exact starts", async () => {
		let context = await setup();
		let ownerStarted = Promise.withResolvers<void>();
		let releaseOwner = Promise.withResolvers<void>();
		let owners = 0;
		let input = {
			channelId: context.channelId,
			question: "Which API contracts changed?",
			requestId: requestId(1),
			requestedBy: context.userId,
		};
		let first = context.service.start({
			...input,
			beforeStart: async () => {
				owners++;
				ownerStarted.resolve();
				await releaseOwner.promise;
			},
		});
		await ownerStarted.promise;
		let second = context.service.start({
			...input,
			beforeStart: () => {
				owners++;
			},
		});
		await Promise.resolve();
		releaseOwner.resolve();
		let [created, repeated] = await Promise.all([first, second]);
		expect(created.repeated).toBe(false);
		expect(repeated.repeated).toBe(true);
		expect(repeated.request.id).toBe(created.request.id);
		expect(owners).toBe(1);
	});

	it("publishes one canonical child while reconciling a completed initial answer after restart", async () => {
		let context = await setup();
		let started = await context.service.start({
			channelId: context.channelId,
			question: "Which API contracts changed?",
			requestId: requestId(1),
			requestedBy: context.userId,
		});
		await settle(context, "research-evidence", evidenceArtifact);
		await context.restart().request(context.channelId, started.request.id);
		await settle(context, "research-answer", answerArtifact);

		let recovered = await context.restart().request(context.channelId, started.request.id);
		expect(recovered).toMatchObject({
			id: started.request.id,
			question: "Which API contracts changed?",
			state: "completed",
			stage: "ready",
			sources: [PUBLIC_SOURCE],
			child: {
				title: REPORT.title,
				summary: REPORT.summary,
				sourceCount: 1,
			},
		});
		let childId = recovered?.child?.id;
		if (!childId) throw new Error("research child was not published");
		let child = await context.storage.channels.get(childId);
		expect(child).toMatchObject({ parentChannelId: context.channelId, title: REPORT.title });
		let stored = await context.storage.collaboration.load(childId, context.advance());
		if (!stored) throw new Error("research child document was not initialized");
		let document = await Plan.readStored(stored);
		expect(document.source).toContain("# Compatibility report");
		expect(document.source).toContain(REPORT.summary);
		expect(document.source).toContain(PUBLIC_SOURCE.url);

		let replayed = await context.restart().request(context.channelId, started.request.id);
		expect(replayed?.child?.id).toBe(childId);
		let listed = await context.storage.channels.list(REPOSITORY_ID, 100);
		expect(listed.channels.filter(value => value.parentChannelId === context.channelId))
			.toHaveLength(1);
	});

	it("keeps transient publication failure readable and retries once on later reconciliation", async () => {
		let context = await setup();
		let started = await context.service.start({
			channelId: context.channelId,
			question: "Which API contracts changed?",
			requestId: requestId(1),
			requestedBy: context.userId,
		});
		await settle(context, "research-evidence", evidenceArtifact);
		await context.service.request(context.channelId, started.request.id);
		let answer = await settle(context, "research-answer", answerArtifact);
		let available = false;
		let attempts = 0;
		let publish = context.storage.research.publishInitialReport.bind(context.storage.research);
		let publication = spyOn(context.storage.research, "publishInitialReport")
			.mockImplementation(input => {
				attempts++;
				if (!available) {
					throw new StorageError("unavailable", "temporary publication outage");
				}
				return publish(input);
			});
		try {
			await context.service.jobChanged(answer.job);
			let retrying = await context.service.request(context.channelId, started.request.id);
			expect(retrying).toMatchObject({ state: "completed", stage: "publishing" });
			expect(retrying?.child).toBeUndefined();
			expect(attempts).toBe(2);
			available = true;
			let ready = await context.service.request(context.channelId, started.request.id);
			expect(ready).toMatchObject({ state: "completed", stage: "ready" });
			expect(attempts).toBe(3);
		} finally {
			publication.mockRestore();
		}
	});

	it("recovers a concurrent child-title conflict on the next reconciliation", async () => {
		let context = await setup();
		let started = await context.service.start({
			channelId: context.channelId,
			question: "Which API contracts changed?",
			requestId: requestId(1),
			requestedBy: context.userId,
		});
		await settle(context, "research-evidence", evidenceArtifact);
		await context.service.request(context.channelId, started.request.id);
		let answer = await settle(context, "research-answer", answerArtifact);
		let publish = context.storage.research.publishInitialReport.bind(context.storage.research);
		let raced = false;
		let publication = spyOn(context.storage.research, "publishInitialReport")
			.mockImplementation(async input => {
				if (!raced) {
					raced = true;
					await context.storage.channels.create({
						id: crypto.randomUUID(),
						repositoryId: REPOSITORY_ID,
						repositoryOwner: "octo-org",
						repositoryName: "score",
						title: input.title,
						createdBy: context.userId,
						now: context.advance(),
					});
				}
				return publish(input);
			});
		try {
			await expect(context.service.jobChanged(answer.job)).resolves.toBeUndefined();
			let ready = await context.service.request(context.channelId, started.request.id);
			expect(ready?.child?.title).toBe(`${REPORT.title} (2)`);
		} finally {
			publication.mockRestore();
		}
	});

	it("does not classify corrupt publication state as retryable", async () => {
		let context = await setup();
		let started = await context.service.start({
			channelId: context.channelId,
			question: "Which API contracts changed?",
			requestId: requestId(1),
			requestedBy: context.userId,
		});
		await settle(context, "research-evidence", evidenceArtifact);
		await context.service.request(context.channelId, started.request.id);
		let answer = await settle(context, "research-answer", answerArtifact);
		let publication = spyOn(context.storage.research, "publishInitialReport")
			.mockRejectedValue(new StorageError("corrupt", "invalid publication state"));
		try {
			await expect(context.service.jobChanged(answer.job)).rejects.toMatchObject({
				failure: "corrupt",
			});
		} finally {
			publication.mockRestore();
		}
	});

	it("rejects a superseded answer instead of retrying publication indefinitely", async () => {
		let context = await setup();
		let started = await context.service.start({
			channelId: context.channelId,
			question: "Which API contracts changed?",
			requestId: requestId(1),
			requestedBy: context.userId,
		});
		await settle(context, "research-evidence", evidenceArtifact);
		await context.service.request(context.channelId, started.request.id);
		let answer = await settle(context, "research-answer", answerArtifact);
		let storedAnswer = await context.storage.jobs.get(context.channelId, answer.job.id);
		if (!storedAnswer) throw new Error("completed answer job is unavailable");
		let replacement = await context.jobs.enqueueUser({
			channelId: context.channelId,
			type: "research-answer",
			targetKey: answer.job.targetKey.replace(/^research-answer:/, ""),
			idempotencyKey: "superseding-answer",
			input: { ...(storedAnswer.job.input as Record<string, JsonValue>), question: "Superseded" },
		});
		expect(replacement.repeated).toBe(false);
		expect(replacement.job.targetGeneration).toBeGreaterThan(answer.job.targetGeneration);

		await expect(context.service.jobChanged(answer.job)).rejects.toMatchObject({
			code: "invalid-state",
		});
	});

	it("publishes hostile report text as plain prose with explicit HTTPS links", async () => {
		let context = await setup();
		let started = await context.service.start({
			channelId: context.channelId,
			question: "Which API contracts changed?",
			requestId: requestId(1),
			requestedBy: context.userId,
		});
		await settle(context, "research-evidence", evidenceArtifact);
		await context.service.request(context.channelId, started.request.id);
		let hostileSource = {
			title: "[Release] > # notes",
			url: "https://example.com/releases/v3?view=full",
		};
		let hostileReport: ResearchReport = {
			title: "# Heading > [not a link]",
			summary: "> quoted\n- listed # not heading",
			findings: [{
				text: "# finding [fake](https://evil.example) <Widget /> {expression}",
				sourceUrls: [hostileSource.url],
			}],
			caveats: ["1. caveat > quote - item [label]"],
		};
		await settle(context, "research-answer", job => {
			let artifact = answerArtifact(job) as Record<string, JsonValue>;
			return { ...artifact, report: hostileReport, sources: [hostileSource] };
		});
		let ready = await context.service.request(context.channelId, started.request.id);
		let stored = await context.storage.collaboration.load(ready!.child!.id, context.advance());
		if (!stored) throw new Error("research child document was not initialized");
		let document = await Plan.readStored(stored);
		let tree = parse(document.source);
		expect(tree.children.map(node => node.type)).toEqual([
			"heading",
			"paragraph",
			"heading",
			"list",
			"heading",
			"list",
			"heading",
			"list",
		]);
		let nodes: Array<Record<string, unknown>> = [];
		let visit = (value: unknown): void => {
			if (!value || typeof value !== "object") return;
			let node = value as Record<string, unknown>;
			nodes.push(node);
			for (let child of Array.isArray(node.children) ? node.children : []) visit(child);
		};
		visit(tree);
		let links = nodes.filter(node => node.type === "link");
		expect(links.map(node => node.url)).toEqual([
			hostileSource.url,
			hostileSource.url,
		]);
		expect(links.map(node => (node.children as Array<{ value: string }>)[0]?.value)).toEqual([
			"1",
			hostileSource.title,
		]);
		expect(nodes.filter(node => node.type === "blockquote")).toEqual([]);
		expect(nodes.filter(node => node.type === "mdxJsxTextElement")).toEqual([]);
		expect(nodes.filter(node => node.type === "mdxTextExpression")).toEqual([]);
		expect(document.source).not.toContain("[fake](https://evil.example)");
	});

	it("does not publish children for failed or cancelled initial work", async () => {
		let failed = await setup();
		let failedRequest = await failed.service.start({
			channelId: failed.channelId,
			question: "Research a failing source",
			requestId: requestId(1),
			requestedBy: failed.userId,
		});
		let claimed = await failed.storage.jobs.claim({
			channelId: failed.channelId,
			claimOwner: "failing-worker",
			count: 1,
			ttlMs: 30_000,
			now: failed.advance(),
			lease: failed.lease,
		});
		await failed.storage.jobs.fail({
			channelId: failed.channelId,
			jobId: claimed[0]!.id,
			claimOwner: "failing-worker",
			claimGeneration: claimed[0]!.claimGeneration,
			reason: "internal-provider-detail",
			now: failed.advance(),
			lease: failed.lease,
		});
		let failure = await failed.restart().request(failed.channelId, failedRequest.request.id);
		expect(failure).toMatchObject({
			state: "failed",
			stage: "failed",
			error: "Research could not be completed.",
		});
		expect(JSON.stringify(failure)).not.toContain("internal-provider-detail");
		expect(
			(await failed.storage.research.get(failed.channelId, failedRequest.request.id))
				?.workspace.publishedChannelId,
		).toBeUndefined();

		let cancelled = await setup();
		let cancelledRequest = await cancelled.service.start({
			channelId: cancelled.channelId,
			question: "Research a cancelled source",
			requestId: requestId(2),
			requestedBy: cancelled.userId,
		});
		let stored = await cancelled.storage.research.get(
			cancelled.channelId,
			cancelledRequest.request.id,
		);
		let cancelledView = await cancelled.service.cancelTurn({
			channelId: cancelled.channelId,
			workspaceId: cancelledRequest.request.id,
			turnId: stored!.turns[0]!.id,
		});
		expect(cancelledView.turns[0]?.evidence?.job.state).toBe("cancelled");
		let cancellation = await cancelled.restart().request(
			cancelled.channelId,
			cancelledRequest.request.id,
		);
		expect(cancellation).toMatchObject({ state: "cancelled", stage: "cancelled" });
		expect(
			(await cancelled.storage.research.get(
				cancelled.channelId,
				cancelledRequest.request.id,
			))?.workspace.publishedChannelId,
		).toBeUndefined();
	});

	it("publishes a deterministic available child title when the report title already exists", async () => {
		let context = await setup();
		await context.storage.channels.create({
			id: crypto.randomUUID(),
			repositoryId: REPOSITORY_ID,
			repositoryOwner: "octo-org",
			repositoryName: "score",
			title: REPORT.title,
			createdBy: context.userId,
			now: context.advance(),
		});
		let started = await context.service.start({
			channelId: context.channelId,
			question: "Which API contracts changed?",
			requestId: requestId(1),
			requestedBy: context.userId,
		});
		await settle(context, "research-evidence", evidenceArtifact);
		await context.service.request(context.channelId, started.request.id);
		let answer = await settle(context, "research-answer", answerArtifact);
		await context.service.jobChanged(answer.job);

		let ready = await context.service.request(context.channelId, started.request.id);
		expect(ready?.child?.title).toBe(`${REPORT.title} (2)`);
	});

	it("bounds long evidence history while retaining the initial and newest batches", () => {
		let evidence = Array.from({ length: 10 }, (_, batch) => ({
			findings: Array.from({ length: 10 }, (_, item) => `finding-${batch}-${item}`),
			sources: Array.from({ length: 10 }, (_, item) => ({
				title: `source-${batch}-${item}`,
				url: `https://source-${batch}-${item}.example/item`,
			})),
		}));
		let bounded = boundedResearchEvidence(evidence);
		expect(bounded.reduce((total, batch) => total + batch.findings.length, 0)).toBe(64);
		expect(bounded.reduce((total, batch) => total + batch.sources.length, 0)).toBe(64);
		expect(bounded[0]).toEqual(evidence[0]);
		expect(bounded[1]).toEqual(evidence[9]);
	});

	it("creates bounded idempotent drafts without scheduling model work", async () => {
		let context = await setup();
		let input = {
			channelId: context.channelId,
			question: `  ${"Question ".repeat(30)}  `,
			requestId: requestId(1),
			origin: "sidebar" as const,
			createdBy: context.userId,
		};
		let first = await context.service.createDraft(input);
		let repeated = await context.service.createDraft(input);
		expect(first.repeated).toBe(false);
		expect(repeated).toEqual({ ...first, repeated: true });
		expect(first.workspace.title.length).toBeLessThanOrEqual(120);
		expect(first.workspace.createdBy).toBe(USER_ID);

		await expect(context.service.createDraft({ ...input, question: "A different question" }))
			.rejects.toBeInstanceOf(StorageError);
		let planner = await context.service.createDraft({
			channelId: context.channelId,
			question: "Review public release evidence",
			origin: "planner",
			originMessageId: "01K39QZG000000000000000001",
			createdBy: context.userId,
		});
		let repeatedPlanner = await context.service.createDraft({
			channelId: context.channelId,
			question: "Review public release evidence",
			origin: "planner",
			originMessageId: "01K39QZG000000000000000001",
			createdBy: context.userId,
			requestId: requestId(9),
		});
		expect(repeatedPlanner).toEqual({ ...planner, repeated: true });
		expect(planner.workspace).toMatchObject({
			origin: "planner",
			originMessageId: "01K39QZG000000000000000001",
			createdBy: USER_ID,
		});
		await expect(context.service.createDraft({
			channelId: context.channelId,
			question: "Invalid internal message identity",
			origin: "planner",
			originMessageId: "message=",
			createdBy: context.userId,
		})).rejects.toMatchObject({ code: "invalid-request" });
		expect((await context.jobs.list(context.channelId, 100))!.jobs).toEqual([]);
		expect(context.publications).toHaveLength(2);
		let stored = await context.storage.research.get(context.channelId, first.workspace.id);
		expect(stored?.turns).toEqual([]);
	});

	it("rejects unavailable execution before confirmation and claims an owner only for new work", async () => {
		let unavailable = await setup({ evidence: false });
		let draft = await unavailable.service.createDraft({
			channelId: unavailable.channelId,
			question: "What changed?",
			requestId: requestId(1),
			origin: "sidebar",
			createdBy: unavailable.userId,
		});
		let started = 0;
		await expect(unavailable.service.confirm({
			channelId: unavailable.channelId,
			workspaceId: draft.workspace.id,
			query: "What changed?",
			requestId: requestId(2),
			confirmedBy: unavailable.userId,
			beforeStart: () => {
				started++;
			},
		})).rejects.toMatchObject({ code: "not-ready" });
		expect(started).toBe(0);
		expect(await unavailable.storage.research.get(unavailable.channelId, draft.workspace.id))
			.toMatchObject({ workspace: { confirmedQuery: undefined }, turns: [], messages: [] });

		let context = await setup();
		let created = await context.service.createDraft({
			channelId: context.channelId,
			question: "What changed?",
			requestId: requestId(1),
			origin: "sidebar",
			createdBy: context.userId,
		});
		let confirmation = {
			channelId: context.channelId,
			workspaceId: created.workspace.id,
			query: "What changed?",
			requestId: requestId(2),
			confirmedBy: context.userId,
			beforeStart: () => {
				started++;
			},
		};
		await context.service.confirm(confirmation);
		await context.service.confirm({
			...confirmation,
			beforeStart: () => {
				throw new Error("a durable replay must not reacquire an owner");
			},
		});
		expect(started).toBe(1);
	});

	it("reconciles completed evidence and never exposes durable request fingerprints", async () => {
		let context = await setup();
		let { created } = await createAndConfirm(context);
		await settle(context, "research-evidence", evidenceArtifact);

		let recovered = await context.service.get(context.channelId, created.workspace.id);
		expect(recovered?.turns[0]).toMatchObject({
			kind: "initial",
			evidence: { job: { state: "completed" } },
			answer: { job: { state: "pending", type: "research-answer" } },
		});
		let source = JSON.stringify(recovered);
		expect(source).not.toContain("idempotencyKey");
		expect(source).not.toContain("fingerprint");
		expect(source).not.toContain("requestId");

		let stored = await context.storage.research.get(context.channelId, created.workspace.id);
		expect(stored?.turns[0]?.answerJobId).toBeDefined();
	});

	it("cancels the active job linked to a turn", async () => {
		let context = await setup();
		let { created, confirmed } = await createAndConfirm(context);
		let cancelled = await context.service.cancelTurn({
			channelId: context.channelId,
			workspaceId: created.workspace.id,
			turnId: confirmed.turns[0]!.id,
		});
		expect(cancelled.turns[0]?.evidence?.job.state).toBe("cancelled");
		let repeated = await context.service.cancelTurn({
			channelId: context.channelId,
			workspaceId: created.workspace.id,
			turnId: confirmed.turns[0]!.id,
		});
		expect(repeated.turns[0]?.evidence?.job.state).toBe("cancelled");
	});

	it("preserves opaque GitHub actor and repository node ids", async () => {
		let context = await setup();
		let { created } = await finishInitial(context);
		let followUp = await context.service.appendTurn({
			channelId: context.channelId,
			workspaceId: created.workspace.id,
			kind: "follow-up",
			question: "Which actor requested this?",
			requestId: requestId(8),
			requestedBy: context.userId,
			requestedByHandle: "octocat",
		});
		let requested = followUp.turns.at(-1)!;
		let member = followUp.messages.find(value => value.turnId === requested.id);
		expect(followUp.workspace).toMatchObject({
			createdBy: USER_ID,
			confirmedBy: USER_ID,
		});
		expect(requested.requestedBy).toBe(USER_ID);
		expect(member?.userId).toBe(USER_ID);
		expect(await context.service.listRepository(REPOSITORY_ID)).toMatchObject({
			channels: [{
				channel: { id: context.channelId },
				workspaces: [{ id: created.workspace.id }],
			}],
		});
	});

	it("uses one repository store operation without scanning or listing each channel", async () => {
		let context = await setup();
		let created = await context.service.createDraft({
			channelId: context.channelId,
			question: "Which API contracts changed?",
			requestId: requestId(1),
			origin: "sidebar",
			createdBy: context.userId,
		});
		let listRepository = context.storage.research.listRepository;
		let calls: Array<{ repositoryId: string; limit: number }> = [];
		context.storage.research.listRepository = async (repositoryId, limit) => {
			calls.push({ repositoryId, limit });
			let listed = await listRepository(repositoryId, limit);
			return { ...listed, truncated: true };
		};
		context.storage.research.list = async () => {
			throw new Error("repository listing must not list one channel at a time");
		};
		context.storage.channels.scan = async () => {
			throw new Error("repository listing must not scan channels in the service");
		};

		let listed = await context.service.listRepository(REPOSITORY_ID);
		expect(calls).toEqual([{ repositoryId: REPOSITORY_ID, limit: 500 }]);
		expect(listed).toMatchObject({
			channels: [{
				channel: { id: context.channelId },
				workspaces: [{ id: created.workspace.id }],
			}],
			truncated: true,
		});
		expect(listed.channels[0]!.workspaces[0]!.createdAt).toBe("2026-08-23T12:00:00.000Z");
	});

	it("keeps follow-ups private, searches only explicit turns, and freezes the original report", async () => {
		let context = await setup();
		let { created } = await finishInitial(context);
		let followUp = await context.service.appendTurn({
			channelId: context.channelId,
			workspaceId: created.workspace.id,
			kind: "follow-up",
			question: " Was the old client tested? ",
			requestId: requestId(3),
			requestedBy: context.userId,
			requestedByHandle: "octocat",
		});
		let followUpTurn = followUp.turns.at(-1)!;
		expect(followUpTurn.evidenceJobId).toBeUndefined();
		expect(followUpTurn.answer?.job.type).toBe("research-answer");
		let followUpJob = await context.storage.jobs.get(
			context.channelId,
			followUpTurn.answerJobId!,
		);
		let followUpInput = parseResearchAnswerInput(followUpJob!.job.input);
		expect(followUpInput.kind).toBe("follow-up");
		if (followUpInput.kind === "initial") throw new Error("expected continuation");
		expect(followUpInput.originalReport).toEqual(REPORT);

		await expect(context.service.appendTurn({
			channelId: context.channelId,
			workspaceId: created.workspace.id,
			kind: "search-more",
			question: "Search while the answer is active",
			requestId: requestId(4),
			requestedBy: context.userId,
		})).rejects.toMatchObject({ code: "active-turn" });

		let completedFollowUp = await settle(
			context,
			"research-answer",
			job => answerArtifact(job, "The old client was tested."),
		);
		await context.service.jobChanged(completedFollowUp.job);
		let search = await context.service.appendTurn({
			channelId: context.channelId,
			workspaceId: created.workspace.id,
			kind: "search-more",
			question: " Find newer compatibility evidence. ",
			requestId: requestId(5),
			requestedBy: context.userId,
			requestedByHandle: "octocat",
		});
		let searchTurn = search.turns.at(-1)!;
		expect(searchTurn.evidence?.job.type).toBe("research-evidence");
		expect(searchTurn.answerJobId).toBeUndefined();
		let evidenceJob = await context.storage.jobs.get(
			context.channelId,
			searchTurn.evidenceJobId!,
		);
		expect(parseResearchEvidenceInput(evidenceJob!.job.input).query)
			.toBe("Find newer compatibility evidence.");

		await settle(context, "research-evidence", evidenceArtifact);
		let reconciled = await context.service.get(context.channelId, created.workspace.id);
		let answerJobId = reconciled!.turns.at(-1)!.answerJobId!;
		let storedAnswer = await context.storage.jobs.get(context.channelId, answerJobId);
		let searchInput = parseResearchAnswerInput(storedAnswer!.job.input);
		expect(searchInput.kind).toBe("search-more");
		if (searchInput.kind === "initial") throw new Error("expected continuation");
		expect(searchInput.originalReport).toEqual(REPORT);
		expect(searchInput.evidence).toHaveLength(2);
	});
});
