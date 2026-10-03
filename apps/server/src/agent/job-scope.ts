/** A background Planner job may read freely but may write only through its own tool. */

import type { ConversationPlan } from "@chopin/protocol";
import type { Chat } from "../chat/service";

type Job = ConversationPlan.Job;

export const JOB_TOOLS: Record<ConversationPlan.JobKind, string> = {
	heading: "draft_heading",
	refine: "refine_decision",
	suggest: "refine_decision",
	prose: "write_decision_prose",
};

export const WRITE_TOOLS: ReadonlySet<string> = new Set([
	"edit_plan",
	"ask",
	"anchor_plan",
	"edit_implementation_graph",
	"create_research_workspace",
	"revise_open_decision",
	...Object.values(JOB_TOOLS),
]);

export function refusal(job: Job | undefined, tool: string): string | undefined {
	let own = job ? JOB_TOOLS[job.kind] : undefined;
	if (!job) {
		return Object.values(JOB_TOOLS).includes(tool)
			? `${tool} is only available to a background Planner job.`
			: undefined;
	}
	if (!WRITE_TOOLS.has(tool) || tool === own) return;
	return `This is a background ${job.kind} job; use only ${own}. ${tool} is not available.`;
}

export async function runJobTool(
	chat: Chat,
	tool: string,
	produce: (job: Job) => Promise<{ output: unknown } & Record<string, unknown>>,
): Promise<unknown> {
	let job = chat.job;
	let refused = refusal(job, tool);
	if (refused) throw new Error(refused);
	if (!job || job.status !== "running") {
		throw new Error("a running background Planner job is required");
	}
	if (tool !== JOB_TOOLS[job.kind]) {
		throw new Error("a background Planner job may run only its own tool");
	}

	let turn = chat.turn;
	let id = job.id;
	let { output, ...reply } = await produce(job);
	if (chat.job !== job || job.id !== id || job.status !== "running" || chat.turn !== turn) {
		throw new Error("background Planner job changed before its tool completed");
	}
	let serialized: string | undefined;
	try {
		serialized = JSON.stringify(output);
	} catch {
		throw new Error("background Planner job output must be valid JSON");
	}
	if (typeof serialized !== "string") {
		throw new Error("background Planner job output must be valid JSON");
	}
	if (serialized.length > 4_096) {
		throw new Error("background Planner job output exceeds 4096 characters");
	}
	chat.jobOutput = serialized;
	return { ok: true, ...(output as object), ...reply };
}
