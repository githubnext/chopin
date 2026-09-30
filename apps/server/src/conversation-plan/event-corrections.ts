import type { Chat, ConversationPlan } from "@chopin/protocol";

type Event = Extract<ConversationPlan.Event, { type: "card.corrected" }>;
type Member = Extract<Chat.Author, { kind: "member" }>;

export function applyCorrectionEvent(
	next: ConversationPlan.State,
	thread: ConversationPlan.Thread,
	event: Event,
): void {
	switch (event.type) {
		case "card.corrected": {
			let change = event.change;
			if (change.kind === "edit" && change.field === "question") {
				thread.question = change.text;
				thread.questionAuthoring = "human-edited";
				thread.questionEditedBy = (event.actor as Member).handle;
			} else if (change.kind === "edit" && change.field === "contribution") {
				let contribution = thread.contributions.find((item) => item.id === change.contributionId);
				if (!contribution) throw new Error("unknown contribution");
				contribution.text = change.text;
				contribution.authoring = "human-edited";
				contribution.editedBy = (event.actor as Member).handle;
			} else if (change.kind === "edit" && change.field === "decision") {
				if (!thread.decision) throw new Error("no current decision");
				thread.decision.text = change.text;
				thread.decision.editedBy = (event.actor as Member).handle;
				let historical = thread.decisionHistory.find((item) => item.id === thread.decision?.id);
				if (historical) {
					historical.text = change.text;
					historical.editedBy = (event.actor as Member).handle;
				}
			} else if (change.kind === "set-status") {
				if (change.status === "reopened" && (thread.status !== "decided" || !thread.decision)) {
					throw new Error("only a decided thread can reopen");
				}
				thread.status = change.status;
				thread.decision = undefined;
			} else if (change.kind === "move") {
				let target = next.threads.find((item) => item.id === change.targetThreadId);
				if (!target || target.id === thread.id || target.version !== change.targetVersion) {
					throw new Error("stale target thread version");
				}
				if (target.contributions.length >= 64) {
					throw new Error("conversation thread contribution limit reached");
				}
				let index = thread.contributions.findIndex((item) => item.id === change.contributionId);
				if (index < 0) throw new Error("unknown contribution");
				let contribution = thread.contributions[index];
				if (
					contribution.kind === "option"
					&& (thread.stanceHistory.some((item) => item.optionId === contribution.id)
						|| thread.contributions.some((item) => item.targetId === contribution.id)
						|| thread.decisionHistory.some((item) => item.optionId === contribution.id))
				) throw new Error("referenced option cannot move alone");
				thread.contributions.splice(index, 1);
				contribution.targetId = target.id;
				target.contributions.push(contribution);
				target.version++;
			} else if (change.kind === "retarget-stance" || change.kind === "dismiss-stance") {
				let index = thread.stances.findIndex((item) => item.id === change.stanceId);
				if (index < 0) throw new Error("stance is not current");
				let stance = thread.stances[index];
				if (change.kind === "retarget-stance") {
					if (
						change.optionId !== undefined
						&& !thread.contributions.some((item) =>
							item.id === change.optionId && item.kind === "option"
						)
					) throw new Error("unknown stance option");
					if (stance.optionId === change.optionId) throw new Error("stance target is unchanged");
					if (
						thread.stances.some((item) =>
							item.id !== stance.id && item.participant === stance.participant
							&& item.optionId === change.optionId
						)
					) throw new Error("participant already has a current stance on target");
					let corrected: ConversationPlan.Stance = {
						...stance,
						id: event.id,
						optionId: change.optionId,
						corrects: stance.id,
						correctedBy: (event.actor as Member).handle,
					};
					thread.stances.splice(index, 1, corrected);
					thread.stanceHistory.push(corrected);
				} else {
					thread.stances.splice(index, 1);
				}
			} else if (change.kind === "retarget-contribution") {
				let contribution = thread.contributions.find((item) => item.id === change.contributionId);
				if (!contribution || contribution.kind === "option") {
					throw new Error("target correction requires a reason or constraint");
				}
				if (
					change.targetId !== thread.id
					&& !thread.contributions.some((item) =>
						item.id === change.targetId && item.kind === "option"
					)
				) throw new Error("unknown contribution target");
				if (contribution.targetId === change.targetId) {
					throw new Error("contribution target is unchanged");
				}
				contribution.targetId = change.targetId;
				contribution.targetEditedBy = (event.actor as Member).handle;
			}
			break;
		}
	}
}
