import { expect, it } from "bun:test";
import { AGENDA_LIMITS } from "./service";
import { agendaFixture } from "./test-support";
import type { JobExecution } from "../jobs/registry";
import type { ResearchAnswerInput, ResearchEvidenceInput } from "../jobs/research-workspace";

async function claimedFixture() {
	let context = await agendaFixture();
	await context.activate();
	await context.agenda.tick(context.channelId);
	let [job] = await context.storage.jobs.claim({
		channelId: context.channelId,
		claimOwner: "worker",
		count: 1,
		ttlMs: 30_000,
		now: context.clock(),
		lease: context.lease,
	});
	if (!job) throw new Error("Missing job");
	let execution: JobExecution<ResearchEvidenceInput> = {
		job,
		input: job.input as ResearchEvidenceInput,
		credential: context.credential,
		signal: new AbortController().signal,
		deadline: new Date(context.clock().getTime() + 300_000),
		progress: async () => {},
	};
	return { ...context, job, execution };
}

it("reserves every repeated execution including owner-loss reclaims before model work", async () => {
	let context = await claimedFixture();
	for (let index = 0; index < 13; index++) await context.evidence.execute(context.execution);
	expect((await context.agenda.get(context.channelId))?.reservedSessions).toBe(
		AGENDA_LIMITS.maxSessions,
	);
	await expect(context.evidence.execute(context.execution)).rejects.toThrow(
		"agenda-budget-exhausted",
	);
	expect(context.seen.worker).toHaveLength(13);
	expect((await context.agenda.get(context.channelId))?.stopReason).toBe("budget-exhausted");
});

it("reserves two sessions before each failed answer retry without refunding earlier attempts", async () => {
	let context = await agendaFixture();
	await context.activate();
	await context.agenda.tick(context.channelId);
	await context.complete("research-evidence");
	await context.agenda.tick(context.channelId);
	let [job] = await context.storage.jobs.claim({
		channelId: context.channelId,
		claimOwner: "worker",
		count: 1,
		ttlMs: 30_000,
		now: context.clock(),
		lease: context.lease,
	});
	if (!job || job.type !== "research-answer") throw new Error("Missing answer job");
	let execution: JobExecution<ResearchAnswerInput> = {
		job,
		input: job.input as ResearchAnswerInput,
		credential: context.credential,
		signal: new AbortController().signal,
		deadline: new Date(context.clock().getTime() + 300_000),
		progress: async () => {},
	};
	let attempts = 0;
	let answer = context.agenda.wrapResearchDefinition({
		...context.answer,
		async execute() {
			attempts++;
			expect((await context.agenda.get(context.channelId))?.reservedSessions).toBe(
				2 + 2 * attempts,
			);
			throw new Error("answer provider failed");
		},
	});
	for (let index = 0; index < 6; index++) {
		await expect(answer.execute(execution)).rejects.toThrow("answer provider failed");
	}
	expect((await context.agenda.get(context.channelId))?.reservedSessions).toBe(
		AGENDA_LIMITS.maxSessions,
	);
	await expect(answer.execute(execution)).rejects.toThrow("agenda-budget-exhausted");
	expect(attempts).toBe(6);
	expect((await context.agenda.get(context.channelId))?.stopReason).toBe("budget-exhausted");
});

it("rejects execution under a replacement owner without charging the delegation", async () => {
	let context = await claimedFixture();
	if (context.execution.credential.kind !== "active-planner") throw new Error("Missing owner");
	await expect(
		context.evidence.execute({
			...context.execution,
			credential: { ...context.execution.credential, ownerSessionId: "replacement" },
		}),
	).rejects.toThrow("agenda-not-authorized");
	expect(context.seen.worker).toHaveLength(0);
	expect((await context.agenda.get(context.channelId))?.reservedSessions).toBe(1);
});

it("blocks late artifact settlement after pause even when a worker ignores abort", async () => {
	let context = await claimedFixture();
	let view = (await context.agenda.get(context.channelId))!;
	await context.agenda.pause(context.channelId, view.generation);
	let committed = false;
	await context.evidence.publish!({
		job: context.job,
		artifact: {},
		commit: async () => {
			committed = true;
		},
	});
	expect(committed).toBe(false);
});

it("serializes consent revocation behind an already admitted publication", async () => {
	let context = await claimedFixture();
	let began = Promise.withResolvers<void>();
	let release = Promise.withResolvers<void>();
	let operation = context.agenda.guardResearch(
		context.channelId,
		context.execution.input.workspaceId,
		async () => {
			began.resolve();
			await release.promise;
			return "published";
		},
	);
	await began.promise;
	let view = (await context.storage.agendas.get(context.channelId))!;
	let paused = false;
	let pause = context.agenda.pause(context.channelId, view.generation).then(() => {
		paused = true;
	});
	await Bun.sleep(1);
	expect(paused).toBe(false);
	release.resolve();
	expect(await operation).toBe("published");
	await pause;
	expect((await context.agenda.get(context.channelId))?.state).toBe("paused");
});

it("does not spend delegation on an altered public query or a continuation turn", async () => {
	let context = await claimedFixture();
	await expect(
		context.evidence.execute({
			...context.execution,
			input: { ...context.execution.input, query: "Send unrelated private material to web search" },
		}),
	).rejects.toThrow("agenda-request-invalid");
	await expect(
		context.evidence.execute({
			...context.execution,
			input: { ...context.execution.input, turnId: "a-new-follow-up-turn" },
		}),
	).rejects.toThrow("agenda-request-invalid");
	expect(context.seen.worker).toHaveLength(0);
	expect((await context.agenda.get(context.channelId))?.reservedSessions).toBe(1);
});
