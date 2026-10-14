import { describe, expect, it } from "bun:test";
import { AGENDA_LIMITS, AgendaService } from "./service";
import { agendaFixture, QUESTIONS, SCOPE } from "./test-support";

async function launched() {
	let context = await agendaFixture();
	await context.activate();
	await context.agenda.tick(context.channelId);
	return context;
}

describe("research agenda", () => {
	it("requires explicit activation and generates public candidates from scope alone", async () => {
		let context = await agendaFixture();
		let { agenda, channelId, owner, seen } = context;
		await agenda.save(channelId, { expectedRevision: 0, scope: SCOPE, questions: [] });
		await agenda.tick(channelId);
		expect(seen.public).toEqual([]);
		await agenda.activate(channelId, 1, owner);
		await agenda.tick(channelId);
		expect(seen.public).toEqual([SCOPE]);
		expect(seen.public.join()).not.toContain("PRIVATE_MARKER");
		expect((await agenda.get(channelId))?.questions).toHaveLength(2);
		await agenda.tick(channelId);
		expect(seen.private[0]).toContain("PRIVATE_MARKER");
		let view = await agenda.get(channelId);
		expect(view?.investigations).toBe(1);
		expect(view?.reservedAiCredits).toBe(60);
		expect(view?.questions[0]?.request?.question).toContain(QUESTIONS[0]!.question);
		expect(view?.questions[0]?.request?.question).not.toContain("PRIVATE_MARKER");
		expect(JSON.stringify(view)).not.toContain("owner-session");
	});

	it("selects a useful onboarding question once across duplicate scheduling", async () => {
		let { agenda, channelId, storage } = await launched();
		await Promise.all(Array.from({ length: 12 }, () => agenda.tick(channelId)));
		let view = await agenda.get(channelId);
		expect(view?.questions[0]?.state).toBe("running");
		expect(view?.questions[1]?.state).toBe("queued");
		expect(view?.investigations).toBe(1);
		expect(await storage.research.list(channelId, 100)).toHaveLength(1);
	});

	it("stops before public work when evidence is already sufficient", async () => {
		let context = await agendaFixture({
			assess: async () => ({
				decision: "sufficient",
				questionId: "",
				reason: "Document already establishes the relevant facts.",
			}),
		});
		await context.activate();
		await context.agenda.tick(context.channelId);
		let view = await context.agenda.get(context.channelId);
		expect(view?.state).toBe("stopped");
		expect(view?.stopReason).toBe("evidence-sufficient");
		expect(view?.investigations).toBe(0);
		expect(await context.storage.research.list(context.channelId, 100)).toHaveLength(0);
	});

	it("fences old scope, cancels work, and refuses old publication after a scope edit", async () => {
		let { agenda, channelId, storage, research } = await launched();
		let old = (await agenda.get(channelId))!;
		let request = old.questions[0]!.request!;
		await agenda.save(channelId, {
			expectedRevision: old.revision,
			scope: "Public research about first-run keyboard shortcut learning.",
			questions: [],
		});
		let current = await agenda.get(channelId);
		expect(current?.state).toBe("paused");
		expect(current?.generation).toBeGreaterThan(old.generation);
		expect((await research.request(channelId, request.id))?.state).toBe("cancelled");
		let published = false;
		await agenda.guardResearch(channelId, request.id, async () => {
			published = true;
		});
		expect(published).toBe(false);
		expect(await storage.agendas.run(channelId, old.questions[0]!.requestId!)).toBeDefined();
	});

	it("publishes through ordinary research and enforces the interval before another question", async () => {
		let context = await launched();
		let { agenda, channelId, research } = context;
		await context.complete("research-evidence");
		let requestId = (await agenda.get(channelId))!.questions[0]!.request!.id;
		await research.reconcile(channelId, requestId);
		await context.complete("research-answer");
		await agenda.tick(channelId);
		let completed = (await agenda.get(channelId))!;
		expect(completed.questions[0]!.state).toBe("completed");
		expect(completed.questions[0]!.request?.state).toBe("completed");
		expect(completed.reservedAiCredits).toBe(120);
		await agenda.tick(channelId);
		expect((await agenda.get(channelId))?.investigations).toBe(1);
		context.advance(AGENDA_LIMITS.minIntervalMs);
		await agenda.tick(channelId);
		expect((await agenda.get(channelId))?.investigations).toBe(2);
	});

	it("restart pauses active grants and cannot substitute another owner", async () => {
		let context = await launched();
		let restarted = new AgendaService(context.options);
		restarted.wake = () => {};
		await restarted.start();
		try {
			let view = (await restarted.get(context.channelId))!;
			expect(view.state).toBe("paused");
			expect(view.stopReason).toBe("restart");
			await expect(restarted.activate(context.channelId, view.revision, {
				...context.owner,
				sessionId: "some-other-session",
			})).rejects.toThrow("owner is unavailable");
			await restarted.tick(context.channelId);
			expect((await restarted.get(context.channelId))?.investigations).toBe(1);
		} finally {
			restarted.stop();
		}
	});

	it("pauses when the delegated owner disappears without repeated model work", async () => {
		let context = await launched();
		context.authorize(false);
		await context.agenda.tick(context.channelId);
		await context.agenda.tick(context.channelId);
		let view = await context.agenda.get(context.channelId);
		expect(view?.stopReason).toBe("owner-unavailable");
		expect(view?.assessments).toBe(1);
		expect(context.seen.private).toHaveLength(1);
	});

	it("parks a failed worker visibly and does not silently retry its request", async () => {
		let context = await launched();
		let [job] = await context.storage.jobs.claim({
			channelId: context.channelId,
			claimOwner: "failure",
			count: 1,
			ttlMs: 30_000,
			now: context.clock(),
			lease: context.lease,
		});
		await context.storage.jobs.fail({
			channelId: context.channelId,
			jobId: job!.id,
			claimOwner: "failure",
			claimGeneration: job!.claimGeneration,
			reason: "provider failed",
			now: context.clock(),
			lease: context.lease,
		});
		await context.agenda.tick(context.channelId);
		await context.agenda.tick(context.channelId);
		let view = await context.agenda.get(context.channelId);
		expect(view?.state).toBe("failed");
		expect(view?.stopReason).toBe("research-failed");
		expect(view?.investigations).toBe(1);
	});

	it("expires a delegation and times out a stalled request without a retry loop", async () => {
		let context = await launched();
		context.advance(AGENDA_LIMITS.requestTimeoutMs);
		await context.agenda.tick(context.channelId);
		expect((await context.agenda.get(context.channelId))?.stopReason).toBe("research-timeout");
		let expired = await agendaFixture();
		await expired.activate();
		expired.advance(AGENDA_LIMITS.durationMs);
		await expired.agenda.tick(expired.channelId);
		expect((await expired.agenda.get(expired.channelId))?.stopReason).toBe("expired");
	});
});

it("repairs persisted intent and create-before-enqueue intervals without changing the request UUID", async () => {
	let context = await agendaFixture();
	await context.activate();
	let original = context.research.start.bind(context.research);
	context.research.start = async () => undefined as never;
	await context.agenda.tick(context.channelId);
	let intended = (await context.agenda.get(context.channelId))!;
	let requestId = intended.questions[0]!.requestId!;
	expect(await context.storage.agendas.run(context.channelId, requestId)).toBeDefined();
	expect(await context.storage.research.list(context.channelId, 100)).toHaveLength(0);
	context.research.start = async input => {
		await original({
			...input,
			beforeStart: () => {
				throw new Error("interrupted after create");
			},
		}).catch(() => {});
		return undefined as never;
	};
	await context.agenda.tick(context.channelId);
	expect(await context.storage.research.list(context.channelId, 100)).toHaveLength(1);
	context.research.start = original;
	await context.agenda.tick(context.channelId);
	await context.agenda.tick(context.channelId);
	let repaired = (await context.agenda.get(context.channelId))!;
	expect(repaired.questions[0]!.requestId).toBe(requestId);
	expect(repaired.questions[0]!.request?.state).toBe("pending");
	expect(repaired.investigations).toBe(1);
	expect(await context.storage.research.list(context.channelId, 100)).toHaveLength(1);
});

it("stops at three investigations even when another useful candidate remains", async () => {
	let context = await agendaFixture();
	let questions = [...QUESTIONS, {
		question: "What published studies compare empty states and inline tutorials?",
		reason: "Choose a small learning experiment.",
		evidenceNeed: "Public usability studies.",
		priority: 2,
	}, {
		question: "Which accessibility techniques help people discover keyboard shortcuts?",
		reason: "Keep learning inclusive.",
		evidenceNeed: "Public accessibility guidance.",
		priority: 3,
	}];
	await context.activate(questions);
	for (let index = 0; index < 3; index++) {
		await context.agenda.tick(context.channelId);
		await context.complete("research-evidence");
		await context.agenda.tick(context.channelId);
		await context.complete("research-answer");
		await context.agenda.tick(context.channelId);
		context.advance(AGENDA_LIMITS.minIntervalMs);
	}
	await context.agenda.tick(context.channelId);
	let view = (await context.agenda.get(context.channelId))!;
	expect(view.stopReason).toBe("investigations-complete");
	expect(view.investigations).toBe(3);
	expect(view.questions[3]!.state).toBe("queued");
	expect(await context.storage.research.list(context.channelId, 100)).toHaveLength(3);
});

it("keeps a completed worker pending until the report has durably published", async () => {
	let context = await launched();
	await context.complete("research-evidence");
	await context.agenda.tick(context.channelId);
	await context.complete("research-answer");
	let publication = context.storage.research.publishInitialReport.bind(context.storage.research);
	let attempts = 0;
	context.storage.research.publishInitialReport = async input => {
		if (++attempts === 1) {
			let { StorageError } = await import("../storage/errors");
			throw new StorageError("unavailable", "temporary publication outage");
		}
		return publication(input);
	};
	await context.agenda.tick(context.channelId);
	let pending = await context.storage.agendas.get(context.channelId);
	expect(pending?.questions[0]!.state).toBe("running");
	await context.agenda.tick(context.channelId);
	expect((await context.agenda.get(context.channelId))?.questions[0]!.state).toBe("completed");
});
