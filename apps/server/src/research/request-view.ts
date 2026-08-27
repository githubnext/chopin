import type { Job, Research } from "@chopin/protocol";
import type { ResearchEvidence } from "../jobs/research-workspace";
import type { JobDetail } from "../jobs/service";
import type { ResearchTurn, ResearchWorkspace } from "../storage/model";

export function projectRequestView(input: {
	workspace: ResearchWorkspace;
	turn: ResearchTurn;
	evidence: JobDetail | undefined;
	answer: JobDetail | undefined;
	sources: ResearchEvidence["sources"];
	child: Research.ReadyChild | undefined;
}): Research.RequestView {
	let state: Job.State = input.answer?.job.state ?? input.evidence?.job.state ?? "pending";
	let base: Research.RequestViewBase = {
		id: input.workspace.id,
		channelId: input.workspace.channelId,
		question: input.turn.question,
		sources: input.sources.map(value => ({ ...value })),
		createdAt: input.workspace.createdAt.toISOString(),
		updatedAt: input.workspace.updatedAt.toISOString(),
	};
	if (state === "failed") {
		return { ...base, state, stage: "failed", error: "Research could not be completed." };
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
		input.evidence?.job.progress.some(value =>
			value.stage === "public-web" && value.state === "started"
		)
	) stage = "searching";
	return { ...base, state, stage };
}
