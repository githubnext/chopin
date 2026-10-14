import { expect, test } from "bun:test";
import { performance } from "@chopin/experiment/fixtures";
import type { Investigation } from "@chopin/experiment/records";
import { backgroundJob, userAndChannel } from "../storage/contract-support";
import { MemoryStorage } from "../storage/memory/adapter";
import { resultEvidence, reviewInstruction } from "./source";

const ORIGINAL = "# Original proposal\n\nCaching should reduce startup time.\n";
const ORIGINAL_HASH = `sha256:${new Bun.CryptoHasher("sha256").update(ORIGINAL).digest("hex")}`;
const REPORT = {
	title: "Caching results",
	summary: "The captured workload contradicts the proposal.",
	findings: [{ text: "Caching increased startup time.", sourceUrls: [] }],
	caveats: ["Only one captured workload was tested."],
};

function initialized() {
	return {
		generation: crypto.randomUUID(),
		epoch: "evidence-epoch",
		source: "# Evidence\n",
		sourceHash: "evidence-hash",
		document: new Uint8Array([1]),
		sidecar: {},
	};
}

async function research(completeReport = true, mismatch?: "workspace" | "turn") {
	let storage = new MemoryStorage();
	let context = await userAndChannel(storage);
	let { channelId, userId, lease } = context;
	let now = new Date();
	let started = await storage.research.start({
		id: crypto.randomUUID(),
		channelId,
		title: "Caching research",
		question: "Does caching help?",
		origin: "inline",
		createdBy: userId,
		turnId: crypto.randomUUID(),
		messageId: crypto.randomUUID(),
		requestId: crypto.randomUUID(),
		idempotencyKey: crypto.randomUUID(),
		fingerprint: "research",
		now,
		lease,
	});
	let workspaceId = started.workspace.id;
	let turnId = started.turn.id;
	let answer = await storage.jobs.enqueue(backgroundJob(channelId, lease, {
		type: "research-answer",
		targetKey: `research-answer:workspace:${workspaceId}:turn:${turnId}:answer`,
		input: {
			workspaceId,
			turnId,
			kind: "initial",
			question: started.turn.question,
			document: { source: ORIGINAL, revision: 7, sourceHash: ORIGINAL_HASH },
			evidence: [],
			history: [],
		},
	}));
	await storage.research.linkJob({
		channelId,
		workspaceId,
		turnId,
		role: "answer",
		jobId: answer.job.id,
		now,
		lease,
	});
	let [claimed] = await storage.jobs.claim({
		channelId,
		count: 1,
		claimOwner: "research",
		ttlMs: 60_000,
		now: new Date(),
		lease,
	});
	await storage.jobs.settle({
		channelId,
		jobId: answer.job.id,
		claimOwner: "research",
		claimGeneration: claimed!.claimGeneration,
		artifact: {
			workspaceId: mismatch === "workspace" ? crypto.randomUUID() : workspaceId,
			turnId: mismatch === "turn" ? crypto.randomUUID() : turnId,
			kind: "initial",
			documentRevision: 7,
			documentSourceHash: ORIGINAL_HASH,
			model: "fixture",
			report: completeReport ? REPORT : { title: "Incomplete" },
			sources: [],
			publicFindings: [],
			privateFindings: ["The captured workload was slower."],
		},
		now: new Date(),
		lease,
	});
	let published = await storage.research.publishInitialReport({
		channelId,
		workspaceId,
		answerJobId: answer.job.id,
		title: "Caching evidence",
		initial: initialized(),
		now: new Date(),
		lease,
	});
	let [receipt] = await storage.followthrough.forSource(channelId, "research", workspaceId);
	return {
		...context,
		storage,
		receipt: receipt!,
		child: published.channel,
		answerJobId: answer.job.id,
	};
}

async function investigation() {
	let storage = new MemoryStorage();
	let seeded = await userAndChannel(storage);
	let channel = await storage.channels.create({
		id: crypto.randomUUID(),
		repositoryId: seeded.repositoryId,
		repositoryOwner: "octo-org",
		repositoryName: "score",
		createdBy: seeded.userId,
		title: "Investigation parent",
		now: new Date(),
	});
	let context = { ...seeded, channelId: channel.id };
	let { channelId, userId, repositoryId, lease } = context;
	let id = crypto.randomUUID();
	let value: Investigation = {
		id,
		documentId: channelId,
		requester: userId,
		brief: "Does caching help?",
		revision: 0,
		state: "publishing",
		generation: 3,
		expiresAt: 0,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		progress: "",
		views: {},
		decisions: [],
		receipts: {},
		candidate: performance,
		input: {
			id,
			documentId: channelId,
			requester: userId,
			authorizer: "octocat",
			brief: "Does caching help?",
			context: ORIGINAL,
			source: { repositoryId, repository: "octo-org/score", commit: "a".repeat(40) },
		},
	};
	await storage.experiments.save(value, undefined, lease);
	delete value.candidate;
	let published = await storage.experiments.publish(
		{ ...value, revision: 1, state: "completed", result: performance },
		0,
		{ title: "Startup evidence", initial: initialized(), now: new Date() },
		lease,
	);
	if (!published) throw new Error("fixture investigation did not publish");
	let [receipt] = await storage.followthrough.forSource(channelId, "investigation", id);
	return { ...context, storage, receipt: receipt!, value: published };
}

test("the review prompt preserves result identity while bounding evidence and current decisions", () => {
	let text = reviewInstruction({
		kind: "investigation",
		sourceId: "investigation-id",
		childId: "child-id",
		title: "Contradictory timing results",
		url: "/org/repo/parent/evidence",
		question: "Does caching help?",
		originalContext: "old context".repeat(10_000),
		result: { report: "Inconclusive measurements".repeat(10_000) },
	}, { planRevision: 19, decisions: [{ rationale: "Human context".repeat(10_000) }] });
	expect(text.length).toBeLessThan(70_000);
	let [admitted, result] = text.split(
		"Current admission context (read again before writing):\n",
	)[1]!
		.split(
			"\n\nUntrusted result data (bounded excerpts; use the read tools for complete content):\n",
		);
	expect(JSON.parse(admitted!)).toMatchObject({ planRevision: 19, decisionsTruncated: true });
	expect(JSON.parse(result!)).toMatchObject({
		sourceId: "investigation-id",
		childId: "child-id",
		url: "/org/repo/parent/evidence",
		question: "Does caching help?",
		resultTruncated: true,
	});
});

test("research evidence retains its exact answer identity and original context after the parent changes", async () => {
	let f = await research();
	let evidence = await resultEvidence(f.storage, f.receipt);
	expect(evidence).toMatchObject({
		kind: "research",
		sourceId: f.receipt.sourceId,
		childId: f.child.id,
		title: "Caching evidence",
		question: "Does caching help?",
		originalContext: ORIGINAL,
		result: { report: REPORT, originalDocumentRevision: 7 },
	});
	expect(evidence?.url).toContain(f.child.slug);
	await f.storage.collaboration.commit({
		channelId: f.channelId,
		expectedRevision: 0,
		epoch: "parent-epoch",
		operationId: crypto.randomUUID(),
		sidecar: { changedBy: "human" },
		events: [],
		now: new Date(),
		lease: f.lease,
	});
	expect((await f.storage.channels.get(f.channelId))?.revision).toBe(1);
	expect(await resultEvidence(f.storage, f.receipt)).toEqual(evidence);
	expect(await resultEvidence(f.storage, { ...f.receipt, sourceId: crypto.randomUUID() }))
		.toBeUndefined();
	expect(await resultEvidence(f.storage, { ...f.receipt, resultKey: "another-answer-job" }))
		.toBeUndefined();
});

test("research needs a complete report even when a malformed completed artifact reached storage", async () => {
	let f = await research(false);
	await expect(resultEvidence(f.storage, f.receipt)).rejects.toThrow();
});

test("research artifacts must identify their exact published workspace and initial turn", async () => {
	for (let mismatch of ["workspace", "turn"] as const) {
		let f = await research(true, mismatch);
		expect(await resultEvidence(f.storage, f.receipt)).toBeUndefined();
	}
});

test("investigation evidence uses the immutable generation while later decisions preserve provenance", async () => {
	let f = await investigation();
	let evidence = await resultEvidence(f.storage, f.receipt);
	expect(evidence).toMatchObject({
		kind: "investigation",
		originalContext: ORIGINAL,
		result: { report: performance.report, provenance: performance.provenance },
	});
	expect(await resultEvidence(f.storage, { ...f.receipt, sourceId: crypto.randomUUID() }))
		.toBeUndefined();
	expect(await resultEvidence(f.storage, { ...f.receipt, resultKey: "4" })).toBeUndefined();
	await f.storage.experiments.save(
		{
			...f.value,
			revision: 2,
			decisions: [{
				id: crypto.randomUUID(),
				view: "comparison",
				state: { revision: 0, fields: {} },
				conclusion: "Keep the simpler path",
				rationale: "This workload does not justify caching.",
				by: "ana",
				userId: f.userId,
				at: Date.now(),
			}],
		},
		1,
		f.lease,
	);
	expect(await resultEvidence(f.storage, f.receipt)).toMatchObject({
		originalContext: ORIGINAL,
		result: { decisions: [{ conclusion: "Keep the simpler path", by: "ana" }] },
	});
	expect(
		(await f.storage.followthrough.forSource(f.channelId, "investigation", f.value.id))[0]
			?.resultKey,
	).toBe("3");
});

test("archived, foreign and unrelated evidence children cannot supply a result", async () => {
	let f = await research();
	for (let id of [f.child.id, f.channelId]) {
		await f.storage.channels.archive({ id, now: new Date() });
		expect(await resultEvidence(f.storage, f.receipt)).toBeUndefined();
		await f.storage.channels.restore({ id, now: new Date() });
	}
	let sibling = await f.storage.channels.create({
		...f.child,
		id: crypto.randomUUID(),
		title: "Unrelated evidence",
		now: new Date(),
	});
	expect(await resultEvidence(f.storage, { ...f.receipt, childId: sibling.id })).toBeUndefined();
	let foreign = await f.storage.channels.create({
		...f.child,
		id: crypto.randomUUID(),
		parentChannelId: undefined,
		repositoryId: "R_foreign",
		title: "Foreign document",
		now: new Date(),
	});
	expect(await resultEvidence(f.storage, { ...f.receipt, childId: foreign.id })).toBeUndefined();
	expect(await resultEvidence(f.storage, { ...f.receipt, childId: crypto.randomUUID() }))
		.toBeUndefined();
});

test("spikes, failed investigations and completed records without a result are excluded", async () => {
	for (let kind of ["spike", "failed", "missing-result"] as const) {
		let f = await investigation();
		let next = { ...f.value, revision: 2 };
		if (kind === "spike") {
			next.spike = {
				digest: "digest",
				passage: "Caching should help.",
				callout: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
				login: "ana",
				placed: true,
			};
		} else if (kind === "failed") next.state = "failed";
		else delete next.result;
		await f.storage.experiments.save(next, 1, f.lease);
		expect(await resultEvidence(f.storage, f.receipt)).toBeUndefined();
	}
});
