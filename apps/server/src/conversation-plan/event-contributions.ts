import type { ConversationPlan } from "@chopin/protocol";
import { activeScopedSupport, currentScopedProposal, targetsScopedProposal } from "./event-support";

type Event = Extract<
	ConversationPlan.Event,
	{
		type:
			| "option.added"
			| "reason.added"
			| "constraint.added"
			| "stance.changed"
			| "option.relabeled";
	}
>;

export function applyContributionEvent(
	next: ConversationPlan.State,
	thread: ConversationPlan.Thread,
	event: Event,
): void {
	switch (event.type) {
		case "option.added":
		case "reason.added":
		case "constraint.added": {
			let kind = event.type.split(".")[0] as ConversationPlan.Contribution["kind"];
			if (event.source && event.source.role !== kind) {
				throw new Error("contribution source role disagrees");
			}
			if (event.origin !== "human" && event.contribution.authoring === "human-edited") {
				throw new Error("inference cannot claim human wording");
			}
			if (
				event.source && event.contribution.authoring === "quoted"
				&& event.contribution.text !== event.source.quote
			) throw new Error("quoted wording must match source");
			if (
				next.threads.some((item) =>
					item.contributions.some((value) => value.id === event.contribution.id)
				)
			) throw new Error("duplicate contribution ID");
			if (thread.contributions.length >= 64) {
				throw new Error("conversation thread contribution limit reached");
			}
			if (
				event.contribution.targetId && event.contribution.targetId !== thread.id
				&& !thread.contributions.some((value) => value.id === event.contribution.targetId)
			) throw new Error("unknown contribution target");
			thread.contributions.push({
				...event.contribution,
				kind,
				sources: event.source ? [event.source] : [],
				actor: event.actor,
			});
			break;
		}
		case "stance.changed": {
			if (event.source.author.kind !== "member") {
				throw new Error("human member required for stance");
			}
			if (
				event.optionId
				&& !thread.contributions.some((item) =>
					item.id === event.optionId && item.kind === "option"
				)
			) throw new Error("unknown stance option");
			if (
				(event.position === "support" && event.source.role !== "support")
				|| (event.position === "oppose" && event.source.role !== "objection")
				|| (event.position === "neutral" && event.source.role !== "withdrawal")
			) throw new Error("stance source role disagrees");
			let stance: ConversationPlan.Stance = {
				id: event.id,
				participant: event.source.author.handle,
				optionId: event.optionId,
				position: event.position,
				sources: [event.source],
				at: event.at,
			};
			thread.stanceHistory.push(stance);
			thread.stances = thread.stances.filter((item) =>
				item.participant !== stance.participant || item.optionId !== stance.optionId
			);
			thread.stances.push(stance);
			if (thread.pendingScopedChoice) {
				let proposal = currentScopedProposal(thread, next.events);
				if (
					proposal && targetsScopedProposal(event, proposal.id, proposal.optionId)
					&& activeScopedSupport([...next.events, event], proposal).length === 0
				) thread.pendingScopedChoice = undefined;
			}
			break;
		}
		case "option.relabeled": {
			if (!thread.questionnaireId || thread.status === "decided" || thread.status === "discarded") {
				throw new Error("option's decision is not open and linked");
			}
			let option = thread.contributions.find(item =>
				item.kind === "option" && item.id === event.optionId
			);
			if (!option) throw new Error("unknown relabel option");
			if (
				option.displayLabel === event.label || !option.displayLabel && option.text === event.label
			) {
				throw new Error("option label is unchanged");
			}
			let folded = event.label.toLocaleLowerCase();
			if (
				thread.contributions.some(item =>
					item.kind === "option" && item.id !== option.id
					&& (item.displayLabel ?? item.text).trim().toLocaleLowerCase() === folded
				)
			) {
				throw new Error("duplicate option label");
			}
			option.displayLabel = event.label;
			break;
		}
	}
}
