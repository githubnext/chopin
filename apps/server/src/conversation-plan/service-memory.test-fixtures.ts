import { expect } from "bun:test";
import type { ConversationPlan } from "@chopin/protocol";
import * as PlanService from "../plan/service";
import { openPlan } from "../testing/plan";
import { createProcessor, type Dependencies, type EffectCommands } from "./service";
import { opened, unlinked } from "./service.test-fixtures";

export async function memoryProcessor() {
	let context = await openPlan();
	let fatals: unknown[] = [];
	context.backend.fatal = error => fatals.push(error);
	context.plan.persistence.fatal = context.backend.fatal;
	let plan = context.plan;
	let processor: ReturnType<typeof createProcessor> | undefined;
	let errors: unknown[] = [];
	let publications: ConversationPlan.State[] = [];
	let committed = structuredClone(plan.conversationPlan);
	let calls: string[] = [];
	let originalCommit = context.storage.collaboration.commit;
	let fail = false;
	context.storage.collaboration.commit = async input => {
		if (fail) {
			fail = false;
			throw new Error("memory commit rejected");
		}
		return originalCommit(input);
	};
	function start(interpret: NonNullable<Dependencies["interpret"]> = async () => unlinked()) {
		let captured = plan;
		processor = createProcessor({
			plan: captured,
			exclusive: action => PlanService.exclusive(captured, action),
			persist: async () => {
				await PlanService.persistExclusive(captured);
				committed = structuredClone(captured.conversationPlan);
			},
			publish: state => {
				expect(state).toEqual(committed);
				publications.push(structuredClone(state));
			},
			active: () => true,
			interpret,
			onError: error => errors.push(error),
		});
		return processor;
	}
	let sink: EffectCommands = {
		target: () => ({ kind: "unlinked" }),
		insertCard: async () => {
			calls.push("insert");
			return "01K0N4W3B7P27CBAEC7A8C8WEA";
		},
		link: async () => {
			calls.push("link");
		},
		addOption: async () => {
			calls.push("option");
		},
		suggest: async () => {
			calls.push("suggest");
		},
		prompt: async () => {
			calls.push("prompt");
		},
		report: error => errors.push(error),
	};
	return {
		get plan() {
			return plan;
		},
		start,
		sink,
		calls,
		errors,
		publications,
		fatals,
		failNextCommit() {
			fail = true;
		},
		async saved() {
			let loaded = await context.storage.collaboration.load(context.channel.id, context.now);
			return (loaded!.sidecar ?? loaded!.snapshot!.sidecar) as unknown as {
				transcript: unknown[];
				conversationPlan: ConversationPlan.State;
				conversationPlanRetries?: Array<{ id: string; messageId: string }>;
				conversationPlanPendingEffects?: unknown[];
				conversationPlanEffects?: string[];
			};
		},
		async reopen() {
			processor?.stop();
			await PlanService.close(plan);
			plan = await PlanService.open(context.channel.id, context.backend, context.server);
			committed = structuredClone(plan.conversationPlan);
			plan.persistence.fatal = context.backend.fatal;
		},
		async close() {
			processor?.stop();
			await PlanService.close(plan);
		},
	};
}

export let opening: NonNullable<Dependencies["interpret"]> = async ({ message }) => ({
	events: [opened(message)],
	analysis: {
		questionSetVersion: "conversation-plan-4",
		modelVersion: "fake",
		status: "applied",
		passes: [],
	},
});
