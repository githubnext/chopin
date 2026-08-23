import * as Plan from "../plan/service";
import { researchQuestionSnapshot } from "./research-question";

import type { Job } from "@chopin/protocol";
import type { Plan as OpenPlan } from "../plan/service";
import type { JobDetail, JobService, JobView } from "./service";

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function jobView(value: JobView): Job.View {
	return {
		id: value.id,
		type: value.type,
		version: value.version,
		origin: value.origin,
		targetKey: value.targetKey,
		targetGeneration: value.targetGeneration,
		state: value.state,
		revision: value.revision,
		attempts: value.attempts,
		failures: value.failures,
		availableAt: value.availableAt.toISOString(),
		...(value.reason ? { reason: value.reason } : {}),
		progress: value.progress.map(entry => ({
			...entry,
			createdAt: entry.createdAt.toISOString(),
		})),
		createdAt: value.createdAt.toISOString(),
		updatedAt: value.updatedAt.toISOString(),
		...(value.subject ? { subject: value.subject } : {}),
	};
}

export function jobDetail(value: JobDetail): Job.Detail {
	return {
		revision: value.revision,
		currentTargetGeneration: value.target.generation,
		job: jobView(value.job),
		...(value.artifact
			? {
				artifact: {
					revision: value.artifact.revision,
					value: value.artifact.value,
					createdAt: value.artifact.createdAt.toISOString(),
				},
			}
			: {}),
	};
}

export async function listJobs(service: JobService, channelId: string): Promise<Job.List.Reply> {
	let page = await service.list(channelId, 100);
	if (!page) throw new Error("channel does not exist");
	return {
		kind: "job:list",
		ts: 0,
		revision: page.revision,
		jobs: page.jobs.map(jobView),
		truncated: !!page.next,
	};
}

export async function getJob(
	service: JobService,
	channelId: string,
	id: string,
): Promise<Job.Get.Reply> {
	let found = await service.get(channelId, id);
	return { kind: "job:get", ts: 0, ...(found ? { detail: jobDetail(found) } : {}) };
}

export async function assignResearchQuestion(
	service: JobService,
	plan: OpenPlan,
	questionId: string,
	requestId: string,
): Promise<Job.Assign.Reply> {
	if (!ULID.test(questionId) || !UUID.test(requestId)) {
		throw new Error("invalid research assignment");
	}
	return Plan.exclusive(plan, async () => {
		let source = Plan.source(plan);
		let snapshot = researchQuestionSnapshot(source, questionId);
		if (!snapshot?.question) throw new Error("research question does not exist");
		let result = await service.enqueueUser({
			channelId: plan.id,
			type: "research-question",
			targetKey: questionId,
			idempotencyKey: `research:${requestId}`,
			input: {
				questionId,
				question: snapshot.question,
				questionHash: snapshot.questionHash,
				revision: plan.revision,
			},
		});
		return { kind: "job:assign", ts: 0, repeated: result.repeated, job: jobView(result.job) };
	});
}

export async function cancelResearchJob(
	service: JobService,
	channelId: string,
	id: string,
): Promise<Job.Cancel.Reply> {
	let found = await service.get(channelId, id);
	if (
		!found
		|| found.job.type !== "research-question"
		|| found.job.origin !== "user"
		|| found.job.targetGeneration !== found.target.generation
	) throw new Error("research job is not cancellable");
	let saved: JobView = await service.cancel({ channelId, jobId: id });
	return { kind: "job:cancel", ts: 0, job: jobView(saved) };
}
