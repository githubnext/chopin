import * as Chat from "./service";
import { authenticatedMemory } from "./job-authenticated-memory.test-fixtures";
import * as Plan from "../plan/service";
import { openPlan } from "../testing/plan";
import { interpretMessage } from "../conversation-plan/interpret";
import { mockResult } from "../conversation-plan/interpret.test-fixtures";
import { createConversationRuntime } from "../conversation-plan/runtime";
import type { Room } from "../rooms";

export async function headingMemory() {
	let opened = await openPlan();
	let plan = opened.plan;
	let identity = await authenticatedMemory(opened);
	let { context } = identity;
	let errors: unknown[] = [];
	let room: Room = { id: opened.channel.id, members: new Map(), plan };
	let runtime = createConversationRuntime({
		config: {
			agent: true,
			conversationPlan: true,
			conversationPlanModel: "offline",
			conversationPlanTimeoutMs: 1_000,
		},
		server: () => opened.server,
		unavailable: () => false,
		interpret: input =>
			interpretMessage({
				...input,
				ask: async request => mockResult(request.questions, { enough_purpose: 0.9 }),
			}),
		onError: error => errors.push(error),
	});
	await runtime.attach(room, plan, false);
	runtime.bind(context);
	let jobs = runtime.jobs(plan)!;
	let processor = runtime.processor(plan)!;
	let closing: Promise<void> | undefined;
	return {
		opened,
		plan,
		jobs,
		processor,
		runtime,
		room,
		errors,
		...identity,
		async saved() {
			let saved = (await opened.storage.collaboration.load(opened.channel.id, opened.now))!;
			return {
				source: (await Plan.readStored(saved)).source,
				sidecar: (saved.sidecar ?? saved.snapshot!.sidecar) as unknown as {
					transcript: typeof plan.chat.entries;
					conversationPlanJobs?: typeof plan.conversationPlanJobs;
					conversationPlanEffects?: string[];
					conversationPlanPendingEffects?: unknown[];
				},
			};
		},
		close() {
			if (closing) return closing;
			let stopped = runtime.stop(plan);
			Chat.cancelQueuedJobs(context, "The document closed.");
			identity.revokeAll();
			closing = stopped.then(() => Plan.close(plan));
			room.closing = closing;
			return closing;
		},
	};
}
