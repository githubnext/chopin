import type { ConversationPlan } from "@chopin/protocol";
import type { JobService } from "../jobs/service";
import {
	parseResearchBriefArtifact,
	type ResearchBriefArtifact,
	type ResearchBriefInput,
	sourceId,
} from "../jobs/research-brief";
import { researchIdentity } from "./research-opportunities";
import type { Dependencies } from "./processor-types";
import { assertStateShape } from "./validation";

export function briefInput(
	offer: ConversationPlan.ResearchOffer,
	state: ConversationPlan.State,
): ResearchBriefInput {
	let workflow = offer.workflow!;
	return {
		offerId: offer.id,
		generation: workflow.generation,
		mode: workflow.mode,
		context: workflow.context,
		sources: workflow.sources,
		previousBrief: offer.brief,
		parentBrief: state.researchOffers?.find(item => item.id === workflow.previousOfferId)?.brief
			?? "",
	};
}

export function applyBriefArtifact(
	offer: ConversationPlan.ResearchOffer,
	artifact: ResearchBriefArtifact,
): ConversationPlan.ResearchOffer {
	let workflow = offer.workflow;
	if (
		!workflow || offer.status !== "offered" || workflow.preparation !== "pending"
		|| artifact.offerId !== offer.id || artifact.generation !== workflow.generation
	) return offer;
	if (artifact.sourceIds.some(id => !workflow.sources.some(source => sourceId(source) === id))) {
		throw new Error("brief artifact sources differ");
	}
	let next = structuredClone(offer);
	let updated = next.workflow!;
	if (updated.mode === "automatic") {
		next.brief = artifact.brief;
		updated.published = true;
	} else {
		let addition = updated.additions.find(item =>
			item.status === "pending"
			&& item.sources.some(source => source.messageId === updated.placementMessageId)
		);
		if (!addition) return offer;
		addition.text = artifact.brief;
	}
	updated.preparation = "ready";
	updated.modelVersion = artifact.model;
	updated.revision++;
	return next;
}

export function createResearchBriefCoordinator(
	deps: Pick<Dependencies, "plan" | "exclusive" | "persist" | "publish" | "active" | "onError"> & {
		jobs: JobService;
	},
) {
	let running: Promise<void> | undefined;
	let requested = false;
	let stopped = false;
	async function scan() {
		let ids = await deps.exclusive(async () =>
			(deps.plan.conversationPlan.researchOffers ?? []).filter(item =>
				item.status === "offered" && item.workflow?.preparation === "pending"
			).map(item => item.id)
		);
		for (let id of ids) {
			if (stopped || !deps.active()) return;
			let captured = await deps.exclusive(async () => {
				let state = deps.plan.conversationPlan;
				let offer = state.researchOffers?.find(item => item.id === id);
				return offer?.workflow && offer.status === "offered"
					? { offer: structuredClone(offer), input: structuredClone(briefInput(offer, state)) }
					: undefined;
			});
			if (!captured) continue;
			let { offer, input } = captured;
			let jobId = offer.workflow!.jobId;
			if (!jobId) {
				let result = await deps.jobs.enqueueScheduler({
					channelId: deps.plan.id,
					type: "research-brief",
					targetKey: offer.id,
					idempotencyKey: researchIdentity("brief", offer.id, String(input.generation)),
					input,
				});
				jobId = result.job.id;
			}
			let detail = await deps.jobs.get(deps.plan.id, jobId);
			if (!detail) continue;
			await deps.exclusive(async () => {
				if (stopped || !deps.active()) return;
				let previous = deps.plan.conversationPlan;
				let current = previous.researchOffers?.find(item => item.id === id);
				if (
					!current?.workflow || current.status !== "offered"
					|| current.workflow.preparation !== "pending"
					|| current.workflow.generation !== input.generation
					|| current.workflow.mode !== input.mode
				) return;
				let updated = structuredClone(current);
				updated.workflow!.jobId = jobId;
				if (detail.job.state === "completed" && detail.artifact) {
					updated = applyBriefArtifact(updated, parseResearchBriefArtifact(detail.artifact.value));
				} else if (["failed", "cancelled", "superseded"].includes(detail.job.state)) {
					updated.workflow!.preparation = "failed";
				}
				if (JSON.stringify(current) === JSON.stringify(updated)) return;
				let next = {
					...previous,
					revision: previous.revision + 1,
					researchOffers: previous.researchOffers!.map(item => item.id === id ? updated : item),
				};
				assertStateShape(next);
				deps.plan.conversationPlan = next;
				try {
					await deps.persist();
				} catch (error) {
					deps.plan.conversationPlan = previous;
					throw error;
				}
				deps.publish(next);
			});
		}
	}
	function wake() {
		if (stopped || !deps.active()) return;
		if (running) {
			requested = true;
			return;
		}
		running = scan().catch(error => deps.onError?.(error)).finally(() => {
			running = undefined;
			if (requested) {
				requested = false;
				wake();
			}
		});
	}
	return {
		wake,
		stop() {
			stopped = true;
		},
		async idle() {
			let pending = running;
			while (pending) {
				await pending;
				pending = running;
			}
		},
	};
}
