import type { JobIntent } from "./effects";
import type { Job, JobOutcome } from "./jobs";
import type { PlannerJobDeps } from "./planner-job-types";
import { proseIntent } from "./prose-job";

export function reason(value: unknown, fallback: string): string {
	let text = value instanceof Error ? value.message : String(value ?? "");
	return text.trim().slice(0, 500) || fallback;
}

export function outcome(value: JobOutcome): JobOutcome {
	if (value?.status === "done") {
		if (
			typeof value.output === "string" && value.output.length > 0 && value.output.length <= 4096
		) {
			try {
				JSON.parse(value.output);
				return value;
			} catch {}
		}
		return { status: "failed", reason: "Invalid Planner job output." };
	}
	if (value?.status === "failed" || value?.status === "skipped") {
		return { status: value.status, reason: reason(value.reason, "Planner job failed.") };
	}
	return { status: "failed", reason: "Invalid Planner job outcome." };
}

function title(plan: PlannerJobDeps["plan"], id: string): string {
	return plan.records.get(id)?.definition.questions[0]?.question ?? "a decision";
}

export function currentProse(plan: PlannerJobDeps["plan"], job: Job): boolean {
	let record = plan.records.get(job.target);
	return !!record && proseIntent(record)?.trigger === job.trigger;
}

export function canonicalIntent(plan: PlannerJobDeps["plan"], intent: JobIntent): JobIntent {
	if (intent.kind !== "refine" && intent.kind !== "suggest") return intent;
	let event = plan.conversationPlan.events.find(item => item.id === intent.trigger);
	if (!event) return intent;
	let thread = plan.conversationPlan.threads.find(item =>
		item.id === event.threadId && item.questionnaireId === intent.target
	);
	let messageId = intent.kind === "refine"
			&& event.type === "card.linked" && event.questionnaireId === intent.target
		? thread?.questionSources[0]?.messageId
		: intent.kind === "suggest" && event.type === "option.added" && thread
		? event.source?.messageId
		: undefined;
	if (!messageId) throw new Error("Planner job event has no matching source message");
	return { ...intent, trigger: messageId };
}

/** The activity copy and target for a completed job, when one is useful. */
export function line(
	plan: PlannerJobDeps["plan"],
	job: Job,
	output: string,
): [string, string, string?] | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(output);
	} catch {}
	let summary = parsed && typeof parsed === "object" && !Array.isArray(parsed)
		? parsed as Record<string, unknown>
		: {};
	let named = typeof summary.title === "string" && summary.title.trim()
		? summary.title.replace(/\s+/g, " ").trim().slice(0, 500)
		: title(plan, job.target).replace(/\s+/g, " ").trim().slice(0, 500);
	let added = typeof summary.added === "number" && Number.isSafeInteger(summary.added)
			&& summary.added >= 0 && summary.added <= 10
		? summary.added
		: 0;
	if (job.kind === "heading") return ["Chopin drafted the title and goal", "document"];
	if (job.kind === "refine") return [`Chopin refined ${named}`, job.target, named];
	if (job.kind === "suggest" && added > 0) {
		return [`Chopin suggested ${added} options for ${named}`, job.target, named];
	}
	if (job.kind === "prose") return [`Chopin wrote up ${named}`, job.target, named];
	return undefined;
}
