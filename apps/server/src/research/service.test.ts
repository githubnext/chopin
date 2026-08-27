import { describe, expect, it, spyOn } from "bun:test";

import { parse } from "@chopin/dialect";
import { parseResearchAnswerInput, parseResearchEvidenceInput } from "../jobs/research-workspace";
import { StorageError } from "../storage/errors";
import * as Plan from "../plan/service";
import { boundedResearchEvidence } from "./service";
import {
	answerArtifact,
	createAndConfirm,
	evidenceArtifact,
	finishInitial,
	PUBLIC_SOURCE,
	reconciledRequest,
	reconciledWorkspace,
	REPORT,
	REPOSITORY_ID,
	requestId,
	settle,
	setup,
	USER_ID,
} from "./test-support";

import type { ResearchReport } from "../jobs/research-workspace";
import type { JsonValue } from "../storage/model";

async function failInitialEvidence(context: Awaited<ReturnType<typeof setup>>) {
	let [claimed] = await context.storage.jobs.claim({
		channelId: context.channelId,
		claimOwner: "failing-worker",
		count: 1,
		ttlMs: 30_000,
		now: context.advance(),
		lease: context.lease,
	});
	if (!claimed) throw new Error("initial evidence job was not claimable");
	await context.storage.jobs.fail({
		channelId: context.channelId,
		jobId: claimed.id,
		claimOwner: "failing-worker",
		claimGeneration: claimed.claimGeneration,
		reason: "internal-provider-detail",
		now: context.advance(),
		lease: context.lease,
	});
	return claimed.id;
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
		await reconciledRequest(context.service, context.channelId, active.request.id);
		await settle(context, "research-answer", answerArtifact);
		await reconciledRequest(context.service, context.channelId, active.request.id);
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
		expect(recovery.publications).toEqual([]);
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

	it("exposes owner setup recovery without starting work on read", async () => {
		let context = await setup();
		let owners = 0;
		let input = {
			channelId: context.channelId,
			question: "Which API contracts changed?",
			requestId: requestId(1),
			requestedBy: context.userId,
		};
		await expect(context.service.start({
			...input,
			beforeStart: () => {
				owners++;
				throw new Error("owner setup failed");
			},
		})).rejects.toThrow("owner setup failed");
		let [workspace] = await context.storage.research.list(context.channelId, 100);
		if (!workspace) throw new Error("durable research request is unavailable");

		let observed = await context.restart().request(context.channelId, workspace.id);
		expect(observed).toMatchObject({ state: "failed", stage: "failed" });
		expect(
			(await context.storage.research.get(context.channelId, workspace.id))?.turns[0]
				?.evidenceJobId,
		).toBeUndefined();
		expect((await context.jobs.list(context.channelId, 100))?.jobs).toEqual([]);

		let recovered = await context.restart().start({
			...input,
			beforeStart: () => {
				owners++;
			},
		});
		expect(recovered.repeated).toBe(true);
		expect(recovered.request.stage).toBe("queued");
		expect(owners).toBe(2);
		expect((await context.jobs.list(context.channelId, 100))?.jobs).toHaveLength(1);
	});

	it("adopts orphan first evidence only after an owner-checked exact retry", async () => {
		let context = await setup();
		let owners = 0;
		let input = {
			channelId: context.channelId,
			question: "Which API contracts changed?",
			requestId: requestId(1),
			requestedBy: context.userId,
		};
		await expect(context.service.start({
			...input,
			beforeStart: () => {
				owners++;
				throw new Error("simulate a crash before first enqueue");
			},
		})).rejects.toThrow("simulate a crash before first enqueue");
		let [workspace] = await context.storage.research.list(context.channelId, 100);
		if (!workspace) throw new Error("durable research request is unavailable");
		let detail = await context.storage.research.get(context.channelId, workspace.id);
		let initial = detail?.turns[0];
		if (!initial) throw new Error("initial research turn is unavailable");
		let existing = await context.jobs.enqueueUser({
			channelId: context.channelId,
			type: "research-evidence",
			targetKey: `workspace:${workspace.id}:turn:${initial.id}:evidence`,
			idempotencyKey: `research-evidence:${initial.id}`,
			input: {
				workspaceId: workspace.id,
				turnId: initial.id,
				query: initial.question,
			},
		});

		let reader = context.restart();
		let before = await reader.request(context.channelId, workspace.id);
		expect(before).toMatchObject({ state: "failed", stage: "failed" });
		expect(
			(await context.storage.research.get(context.channelId, workspace.id))?.turns[0]
				?.evidenceJobId,
		).toBeUndefined();

		let observed = await reconciledRequest(
			reader,
			context.channelId,
			workspace.id,
		);
		expect(observed).toMatchObject({ state: "failed", stage: "failed" });
		expect(
			(await context.storage.research.get(context.channelId, workspace.id))?.turns[0]
				?.evidenceJobId,
		).toBeUndefined();
		expect((await context.jobs.list(context.channelId, 100))?.jobs).toHaveLength(1);

		let recovered = await context.restart().start({
			...input,
			beforeStart: () => {
				owners++;
			},
		});
		expect(recovered.repeated).toBe(true);
		expect(
			(await context.storage.research.get(context.channelId, workspace.id))?.turns[0]
				?.evidenceJobId,
		).toBe(existing.job.id);
		expect(owners).toBe(2);
		expect((await context.jobs.list(context.channelId, 100))?.jobs).toHaveLength(1);
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
		await reconciledRequest(context.restart(), context.channelId, started.request.id);
		await settle(context, "research-answer", answerArtifact);

		let recovered = await reconciledRequest(
			context.restart(),
			context.channelId,
			started.request.id,
		);
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
		await reconciledRequest(context.service, context.channelId, started.request.id);
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
			let retrying = await reconciledRequest(
				context.service,
				context.channelId,
				started.request.id,
			);
			expect(retrying).toMatchObject({ state: "completed", stage: "publishing" });
			expect(retrying?.child).toBeUndefined();
			expect(attempts).toBe(2);
			available = true;
			let ready = await reconciledRequest(
				context.service,
				context.channelId,
				started.request.id,
			);
			expect(ready).toMatchObject({ state: "completed", stage: "ready" });
			expect(attempts).toBe(3);
		} finally {
			publication.mockRestore();
		}
	});

	it("reserves a title collision atomically during publication", async () => {
		let context = await setup();
		let started = await context.service.start({
			channelId: context.channelId,
			question: "Which API contracts changed?",
			requestId: requestId(1),
			requestedBy: context.userId,
		});
		await settle(context, "research-evidence", evidenceArtifact);
		await reconciledRequest(context.service, context.channelId, started.request.id);
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
		await reconciledRequest(context.service, context.channelId, started.request.id);
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
		await reconciledRequest(context.service, context.channelId, started.request.id);
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
		await reconciledRequest(context.service, context.channelId, started.request.id);
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
		let ready = await reconciledRequest(context.service, context.channelId, started.request.id);
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

	it("retries failed and cancelled work on the same immutable request", async () => {
		for (let terminal of ["failed", "cancelled"] as const) {
			let context = await setup();
			let started = await context.service.start({
				channelId: context.channelId,
				question: `  Preserve the ${terminal} brief exactly.  `,
				requestId: requestId(31),
				requestedBy: context.userId,
			});
			let before = await context.storage.research.get(context.channelId, started.request.id);
			let oldJobId = before!.turns[0]!.evidenceJobId!;
			if (terminal === "failed") await failInitialEvidence(context);
			else {
				await context.service.cancelRequest({
					channelId: context.channelId,
					workspaceId: started.request.id,
				});
			}
			let owners = 0;

			let retried = await context.service.retryRequest({
				channelId: context.channelId,
				workspaceId: started.request.id,
				beforeStart: () => {
					owners++;
				},
			});

			expect(retried).toMatchObject({
				id: started.request.id,
				question: started.request.question,
				stage: "queued",
			});
			let after = await context.storage.research.get(context.channelId, started.request.id);
			expect(after!.turns).toHaveLength(1);
			expect(after!.turns[0]!.evidenceJobId).not.toBe(oldJobId);
			expect(await context.storage.research.findTurnByJob(context.channelId, oldJobId))
				.toBeUndefined();
			expect(owners).toBe(1);
		}
	});

	it("replaces terminal answer attempts before publishing the retried request", async () => {
		for (let terminal of ["failed", "cancelled"] as const) {
			let context = await setup();
			let started = await context.service.start({
				channelId: context.channelId,
				question: `Retry a ${terminal} answer`,
				requestId: requestId(36),
				requestedBy: context.userId,
			});
			let firstEvidence = await settle(context, "research-evidence", evidenceArtifact);
			await context.service.jobChanged(firstEvidence.job);
			let before = await context.storage.research.get(context.channelId, started.request.id);
			let oldAnswerId = before!.turns[0]!.answerJobId!;
			if (terminal === "failed") {
				let [answer] = await context.storage.jobs.claim({
					channelId: context.channelId,
					claimOwner: "failing-answer-worker",
					count: 100,
					ttlMs: 30_000,
					now: context.advance(),
					lease: context.lease,
				});
				await context.storage.jobs.fail({
					channelId: context.channelId,
					jobId: answer!.id,
					claimOwner: "failing-answer-worker",
					claimGeneration: answer!.claimGeneration,
					reason: "answer failed",
					now: context.advance(),
					lease: context.lease,
				});
			} else {
				await context.service.cancelRequest({
					channelId: context.channelId,
					workspaceId: started.request.id,
				});
			}

			await context.service.retryRequest({
				channelId: context.channelId,
				workspaceId: started.request.id,
			});
			expect(await context.storage.research.findTurnByJob(context.channelId, oldAnswerId))
				.toBeUndefined();
			let nextEvidence = await settle(context, "research-evidence", evidenceArtifact);
			await context.service.jobChanged(nextEvidence.job);
			let retried = await context.storage.research.get(context.channelId, started.request.id);
			let nextAnswerId = retried!.turns[0]!.answerJobId;
			expect(nextAnswerId).toBeDefined();
			if (!nextAnswerId) throw new Error("retried answer was not linked");
			expect(nextAnswerId).not.toBe(oldAnswerId);
			let nextAnswer = await settle(context, "research-answer", answerArtifact);
			expect(nextAnswer.job.id).toBe(nextAnswerId);
			await context.service.jobChanged(nextAnswer.job);
			expect(await context.service.request(context.channelId, started.request.id))
				.toMatchObject({ id: started.request.id, stage: "ready" });
		}
	});

	it("rejects retry for active and ready requests", async () => {
		let active = await setup();
		let activeRequest = await active.service.start({
			channelId: active.channelId,
			question: "Active request",
			requestId: requestId(32),
			requestedBy: active.userId,
		});
		await expect(active.service.retryRequest({
			channelId: active.channelId,
			workspaceId: activeRequest.request.id,
		})).rejects.toMatchObject({ code: "active-turn" });

		let ready = await setup();
		let readyRequest = await ready.service.start({
			channelId: ready.channelId,
			question: "Ready request",
			requestId: requestId(33),
			requestedBy: ready.userId,
		});
		let evidence = await settle(ready, "research-evidence", evidenceArtifact);
		await ready.service.jobChanged(evidence.job);
		let answer = await settle(ready, "research-answer", answerArtifact);
		await ready.service.jobChanged(answer.job);
		expect((await ready.service.request(ready.channelId, readyRequest.request.id))?.stage)
			.toBe("ready");
		await expect(ready.service.retryRequest({
			channelId: ready.channelId,
			workspaceId: readyRequest.request.id,
		})).rejects.toMatchObject({ code: "not-ready" });
	});

	it("creates at most one new evidence job across concurrent retries", async () => {
		let context = await setup();
		let started = await context.service.start({
			channelId: context.channelId,
			question: "Retry concurrently",
			requestId: requestId(34),
			requestedBy: context.userId,
		});
		await failInitialEvidence(context);
		let owners = 0;
		let retry = () =>
			context.service.retryRequest({
				channelId: context.channelId,
				workspaceId: started.request.id,
				beforeStart: () => {
					owners++;
				},
			});

		let results = await Promise.allSettled([retry(), retry()]);

		expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
		expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
		let jobs = await context.storage.jobs.list(context.channelId, 100);
		expect(jobs!.jobs.filter(job => job.type === "research-evidence")).toHaveLength(2);
		expect(owners).toBe(1);
	});

	it("requires an explicit retry to recover after links were durably cleared", async () => {
		let context = await setup();
		let started = await context.service.start({
			channelId: context.channelId,
			question: "Recover a cleared retry",
			requestId: requestId(35),
			requestedBy: context.userId,
		});
		let oldJobId = await failInitialEvidence(context);
		await context.storage.research.resetInitialAttempt({
			channelId: context.channelId,
			workspaceId: started.request.id,
			expectedEvidenceJobId: oldJobId,
			expectedAnswerJobId: undefined,
			now: context.advance(),
			lease: context.lease,
		});
		let beforeRead = await context.storage.jobs.list(context.channelId, 100);

		let observed = await context.restart().request(context.channelId, started.request.id);

		expect(observed).toMatchObject({
			state: "failed",
			stage: "failed",
			error: "Research could not be completed.",
			question: started.request.question,
		});
		expect((await context.storage.jobs.list(context.channelId, 100))!.jobs)
			.toHaveLength(beforeRead!.jobs.length);
		await context.restart().retryRequest({
			channelId: context.channelId,
			workspaceId: started.request.id,
		});
		let recovered = await context.storage.research.get(context.channelId, started.request.id);
		expect(recovered!.turns[0]!.evidenceJobId).toBeDefined();
		expect(recovered!.turns[0]!.evidenceJobId).not.toBe(oldJobId);
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
		await reconciledRequest(context.service, context.channelId, started.request.id);
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

		let recovered = await reconciledWorkspace(
			context.service,
			context.channelId,
			created.workspace.id,
		);
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
		let reconciled = await reconciledWorkspace(
			context.service,
			context.channelId,
			created.workspace.id,
		);
		let answerJobId = reconciled!.turns.at(-1)!.answerJobId!;
		let storedAnswer = await context.storage.jobs.get(context.channelId, answerJobId);
		let searchInput = parseResearchAnswerInput(storedAnswer!.job.input);
		expect(searchInput.kind).toBe("search-more");
		if (searchInput.kind === "initial") throw new Error("expected continuation");
		expect(searchInput.originalReport).toEqual(REPORT);
		expect(searchInput.evidence).toHaveLength(2);
	});
});
