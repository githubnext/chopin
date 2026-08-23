import type { Job } from "@chopin/protocol";
import type { JobDetail, JobService, JobView } from "./service";

const ACTIVE = new Set<Job.State>(["pending", "paused", "running"]);

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

export async function cancelResearchWorkspaceJob(
	service: JobService,
	channelId: string,
	id: string,
): Promise<Job.Cancel.Reply> {
	let found = await service.get(channelId, id);
	if (
		!found
		|| (found.job.type !== "research-evidence" && found.job.type !== "research-answer")
		|| found.job.origin !== "user"
		|| found.job.targetGeneration !== found.target.generation
	) throw new Error("research job is not cancellable");
	if (found.job.state === "cancelled") {
		return { kind: "job:cancel", ts: 0, job: jobView(found.job) };
	}
	if (!ACTIVE.has(found.job.state)) throw new Error("research job is not cancellable");
	let saved: JobView = await service.cancel({ channelId, jobId: id });
	return { kind: "job:cancel", ts: 0, job: jobView(saved) };
}
