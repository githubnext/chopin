import type { Chat } from "@chopin/protocol";
import * as Service from "../plan/service";
import { openPlan } from "../testing/plan";
import { JobRegistry } from "../jobs/registry";
import { JobService } from "../jobs/service";
import { documentDevelopmentDefinition } from "./job";
import { DocumentDevelopment, type Options } from "./runtime";
import type { DocumentDevelopmentInput, DocumentDevelopmentOutput } from "./schema";

export async function runtimeFixture(source = "# Working document\n") {
	let context = await openPlan(source);
	let plan = context.plan;
	let now = Date.now();
	let timers: Array<{ ms: number; run: () => void; cancelled: boolean }> = [];
	let allowed = true;
	let active = true;
	let errors: unknown[] = [];
	let jobs = new JobService({
		storage: context.storage,
		lease: () => context.lease,
		registry: new JobRegistry([documentDevelopmentDefinition({
			config: { agent: true, model: "fixture" },
			engine: async () => ({ changes: [], removals: [], model: "fixture" }),
		})]),
	});
	let options: Options = {
		jobs,
		withPlan: async (_id, action) => action(plan, () => active),
		authorize: async () => allowed ? { valid: () => allowed, release() {} } : undefined,
		now: () => now,
		after(ms, run) {
			let timer = { ms, run, cancelled: false };
			timers.push(timer);
			return () => {
				timer.cancelled = true;
			};
		},
		error: error => errors.push(error),
	};
	let runtime = new DocumentDevelopment(options);
	return {
		...context,
		get plan() {
			return plan;
		},
		get runtime() {
			return runtime;
		},
		jobs,
		timers,
		errors,
		options,
		advance(ms: number) {
			now += ms;
		},
		allowed(value: boolean) {
			allowed = value;
		},
		active(value: boolean) {
			active = value;
		},
		async say(id: string, text: string, author = "mona", to?: "planner") {
			let entry: Chat.Entry = {
				id,
				text,
				ts: now / 1000,
				author: { kind: "member", handle: author },
				...(to ? { to } : {}),
			};
			plan.chat.entries.push(entry);
			await Service.persist(plan);
			runtime.message(plan, entry);
			return entry;
		},
		async settle(output: DocumentDevelopmentOutput) {
			let pending = plan.documentDevelopment?.pending;
			if (!pending?.jobId) throw new Error("fixture has no queued job");
			let [claim] = await context.storage.jobs.claim({
				channelId: plan.id,
				claimOwner: "fixture",
				count: 1,
				ttlMs: 60_000,
				now: new Date(),
				lease: context.lease,
			});
			if (!claim || claim.id !== pending.jobId) throw new Error("fixture could not claim job");
			let input = claim.input as DocumentDevelopmentInput;
			return jobs.settle({
				channelId: plan.id,
				jobId: claim.id,
				claimOwner: "fixture",
				claimGeneration: claim.claimGeneration,
				artifact: {
					messageId: input.messageId,
					revision: input.revision,
					decisionHash: input.decisionHash,
					...output,
					model: "fixture",
				},
			});
		},
		async reopen() {
			await runtime.close();
			await Service.close(plan);
			plan = await Service.open(context.channel.id, context.backend, context.server);
			runtime = new DocumentDevelopment(options);
		},
		async close() {
			await runtime.close();
			await Service.close(plan);
			await context.storage.close();
		},
	};
}
