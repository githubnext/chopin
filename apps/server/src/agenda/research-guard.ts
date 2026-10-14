import { JobExecutionError } from "../jobs/registry";
import { AGENDA_LIMITS, runnable, sameOwner } from "./domain";
import type { AgendaState } from "./state";
import type { JobDefinition } from "../jobs/registry";
import type { JsonValue } from "../storage/model";
import type { AgendaRun } from "../storage/agenda";

async function associated(state: AgendaState, channelId: string, workspaceId: string) {
	let detail = await state.options.storage.research.get(channelId, workspaceId);
	let initial = detail?.turns.find(turn => turn.kind === "initial");
	return initial && state.options.storage.agendas.run(channelId, initial.requestId);
}

async function permitted(state: AgendaState, run: AgendaRun) {
	let record = await state.options.storage.agendas.get(run.channelId);
	let channel = await state.options.storage.channels.get(run.channelId);
	if (
		!record || !runnable(record, state.clock()) || record.generation !== run.generation
		|| !record.owner || !sameOwner(record.owner, run.owner)
		|| !channel || channel.archivedAt || channel.parentChannelId
		|| Date.parse(run.deadline) <= state.clock().getTime()
		|| !record.questions.some(item => item.requestId === run.id && item.state === "running")
		|| !state.options.available()
	) return undefined;
	let credential = await state.credential(record);
	if (!credential) return undefined;
	credential.release();
	return record;
}

/** Holding the consent lock through the operation closes pause-versus-publication races. */
export async function guardResearch<T>(
	state: AgendaState,
	channelId: string,
	workspaceId: string,
	operation: () => Promise<T>,
): Promise<T | undefined> {
	let run = await associated(state, channelId, workspaceId);
	if (!run) return operation();
	return state.exclusive(channelId, async () => {
		if (!await permitted(state, run)) return undefined;
		await state.options.storage.agendas.linkRun({
			channelId,
			requestId: run.id,
			workspaceId,
			lease: state.options.lease(),
		});
		return operation();
	});
}

/** Reserve the *actual attempt*, including retries and owner-loss reclaims, before any model call. */
export function wrapResearchDefinition<Input extends JsonValue, Artifact extends JsonValue>(
	state: AgendaState,
	definition: JobDefinition<Input, Artifact>,
): JobDefinition<Input, Artifact> {
	if (definition.type !== "research-evidence" && definition.type !== "research-answer") {
		throw new Error("Only research definitions can use the agenda guard.");
	}
	return {
		...definition,
		async execute(execution) {
			let input = execution.input as Record<string, JsonValue>;
			let workspaceId = input.workspaceId;
			if (typeof workspaceId !== "string") throw new JobExecutionError("agenda-request-invalid");
			let run = await associated(state, execution.job.channelId, workspaceId);
			if (!run) return definition.execute(execution);
			let detail = await state.options.storage.research.get(run.channelId, workspaceId);
			let initial = detail?.turns.find(turn => turn.kind === "initial");
			if (
				input.turnId !== initial?.id
				|| (definition.type === "research-evidence"
					? input.query !== run.question
					: input.question !== run.question || input.kind !== "initial")
			) {
				throw new JobExecutionError("agenda-request-invalid");
			}
			let tracked = await state.exclusive(run.channelId, async () => {
				let record = await permitted(state, run);
				let credential = execution.credential;
				if (
					!record || credential.kind !== "active-planner"
					|| credential.ownerSessionId !== run.owner.sessionId
					|| credential.ownerGeneration !== run.owner.generation
					|| credential.credentialRevision !== run.owner.credentialRevision
				) {
					throw new JobExecutionError("agenda-not-authorized");
				}
				let credits = definition.type === "research-evidence" ? 30 : 60;
				if (record.reservedAiCredits + credits > AGENDA_LIMITS.maxAiCredits) {
					await state.park(record, "budget-exhausted");
					throw new JobExecutionError("agenda-budget-exhausted");
				}
				await state.store({ ...record, reservedAiCredits: record.reservedAiCredits + credits });
				return state.track(run.channelId);
			});
			try {
				let signal = AbortSignal.any([
					execution.signal,
					tracked.controller.signal,
					AbortSignal.timeout(Math.max(1, Date.parse(run.deadline) - state.clock().getTime())),
				]);
				return await definition.execute({ ...execution, signal });
			} finally {
				tracked.release();
			}
		},
		async publish(publication) {
			let input = publication.job.input as Record<string, JsonValue>;
			if (typeof input.workspaceId !== "string") {
				throw new JobExecutionError("agenda-request-invalid");
			}
			await guardResearch(state, publication.job.channelId, input.workspaceId, async () => {
				if (definition.publish) await definition.publish(publication);
				else await publication.commit();
			});
		},
	};
}
