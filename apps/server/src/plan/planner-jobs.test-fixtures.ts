import type { ConversationPlan } from "@chopin/protocol";
import * as Service from "./service";
import { openPlan } from "../testing/plan";

export const AT = "2026-09-25T10:00:00.000Z";

export let running: ConversationPlan.Job = {
	id: "refine:W1:m1",
	kind: "refine",
	target: "W1",
	trigger: "m1",
	status: "running",
	attempts: 0,
	at: AT,
};

export async function storedRunning(extra: ConversationPlan.Job[] = []) {
	let context = await openPlan();
	context.plan.conversationPlanJobs = [running, ...extra];
	await Service.persist(context.plan);
	await Service.close(context.plan);
	return context;
}
