import type { Job, Research } from "@chopin/protocol";
import type { ResearchEvidence } from "../jobs/research-workspace";
import type { JobDetail } from "../jobs/service";
import type { ResearchTurn, ResearchWorkspace } from "../storage/model";

export function researchFailureMessage(reason: string | undefined): string {
	let code = reason?.replace(/^attempts-exhausted:/, "");
	let messages: Record<string, string> = {
		"attempt-timeout": "Research timed out before it returned a result.",
		"web-search-timeout": "A public web-search request timed out.",
		"web-search-authorization-timeout": "Authorization for public web search timed out.",
		"web-search-unavailable": "The public web-search service was unavailable.",
		"web-search-failed": "Public web search did not complete successfully.",
		"web-search-not-invoked": "The research model did not perform a web search.",
		"public-session-failed": "The public research model could not complete its session.",
		"research-result-missing": "The research model did not return its findings.",
		"research-result-invalid": "The research model returned invalid findings.",
		"research-source-mismatch": "The research findings included unverified sources.",
	};
	return code && Object.hasOwn(messages, code)
		? messages[code]!
		: "Research could not be completed.";
}

export function projectRequestView(input: {
	workspace: ResearchWorkspace;
	turn: ResearchTurn;
	evidence: JobDetail | undefined;
	answer: JobDetail | undefined;
	sources: ResearchEvidence["sources"];
	child: Research.ReadyChild | undefined;
}): Research.RequestView {
	let unlinked = !input.turn.evidenceJobId && !input.turn.answerJobId;
	let state: Job.State = unlinked
		? "failed"
		: input.answer?.job.state ?? input.evidence?.job.state ?? "pending";
	let current = input.answer?.job ?? input.evidence?.job;
	let progress = current?.progress.findLast(item => item.attempt === current.attempts);
	let activity = state === "running" && progress?.state === "started" ? progress.label : undefined;
	let base: Research.RequestViewBase = {
		id: input.workspace.id,
		channelId: input.workspace.channelId,
		question: input.turn.question,
		sources: input.sources.map(value => ({ ...value })),
		createdAt: input.workspace.createdAt.toISOString(),
		updatedAt: input.workspace.updatedAt.toISOString(),
		...(activity ? { activity } : {}),
	};
	if (state === "failed") {
		return { ...base, state, stage: "failed", error: researchFailureMessage(current?.reason) };
	}
	if (state === "cancelled" || state === "superseded") {
		return { ...base, state, stage: "cancelled" };
	}
	if (input.child) return { ...base, state: "completed", stage: "ready", child: input.child };
	let stage: Research.ActiveRequestStage = "queued";
	if (input.answer?.job.state === "completed") stage = "publishing";
	else if (input.answer) {
		stage = input.answer.job.progress.some(value =>
				value.stage === "report-synthesis" && value.state === "started"
			)
			? "writing"
			: "analyzing";
	} else if (
		input.evidence?.job.state === "running"
		|| input.evidence?.job.progress.some(value =>
			value.stage === "public-web" && value.state === "started"
		)
	) stage = "searching";
	return { ...base, state, stage };
}
