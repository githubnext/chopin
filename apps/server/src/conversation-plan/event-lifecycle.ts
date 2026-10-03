import type { Chat, ConversationPlan } from "@chopin/protocol";

type Event = Extract<
	ConversationPlan.Event,
	{
		type:
			| "thread.leaning"
			| "decision.recorded"
			| "decision.reopened"
			| "candidate.proposed"
			| "candidate.confirmed"
			| "candidate.rejected"
			| "card.linked"
			| "thread.discarded";
	}
>;
type Member = Extract<Chat.Author, { kind: "member" }>;

export function applyLifecycleEvent(thread: ConversationPlan.Thread, event: Event): void {
	switch (event.type) {
		case "thread.leaning": {
			if (thread.status === "decided" || thread.status === "discarded") {
				throw new Error("cannot infer leaning over a closed thread");
			}
			let supporters = new Set(
				thread.stances.filter((item) =>
					item.position === "support" && item.optionId === event.optionId
				).map((item) => item.participant),
			);
			if (supporters.size < 2) throw new Error("leaning needs several participant stances");
			thread.status = "leaning";
			break;
		}
		case "decision.recorded": {
			if (thread.status === "discarded") throw new Error("thread is discarded");
			if (thread.status === "decided") throw new Error("decision must be reopened first");
			if (
				event.origin !== "human"
				&& (event.source?.author.kind !== "member" || event.source.role !== "resolution")
			) throw new Error("decision requires explicit human resolution");
			if (
				event.optionId
				&& !thread.contributions.some((item) =>
					item.id === event.optionId && item.kind === "option"
				)
			) throw new Error("unknown decision option");
			if (
				event.origin !== "human"
				&& thread.stances.some((item) =>
					item.position === "oppose" && (!item.optionId || item.optionId === event.optionId)
				)
			) throw new Error("contradictory stance needs human resolution");
			let decision: ConversationPlan.Decision = {
				id: event.id,
				text: event.text,
				optionId: event.optionId,
				sources: event.source ? [event.source] : [],
				actor: event.origin === "human" ? event.actor as Member : event.source!.author as Member,
				at: event.at,
			};
			thread.decision = decision;
			thread.decisionHistory.push(decision);
			thread.status = "decided";
			thread.pendingSettle = undefined;
			thread.pendingScopedChoice = undefined;
			break;
		}
		case "decision.reopened":
			if (thread.status !== "decided") throw new Error("only a decided thread can reopen");
			if (
				event.origin !== "human"
				&& (event.source?.author.kind !== "member" || event.source.role !== "reopening")
			) throw new Error("reopening requires explicit human statement");
			thread.decision = undefined;
			thread.status = "reopened";
			thread.pendingSettle = undefined;
			break;
		case "candidate.proposed":
			if (event.source.role !== event.candidate.kind) {
				throw new Error("candidate source role disagrees");
			}
			if (thread.candidates.some((candidate) => candidate.id === event.candidate.id)) {
				throw new Error("duplicate candidate ID");
			}
			if ((event.candidate.kind === "reopening") !== (thread.status === "decided")) {
				throw new Error("candidate does not match thread status");
			}
			thread.candidates.push({ ...event.candidate, sources: [event.source], status: "pending" });
			break;
		case "candidate.confirmed":
		case "candidate.rejected": {
			let candidate = thread.candidates.find((item) => item.id === event.candidateId);
			if (!candidate || candidate.status !== "pending") throw new Error("candidate is not pending");
			if (
				event.type === "candidate.confirmed"
				&& ((candidate.kind === "reopening") !== (thread.status === "decided"))
			) throw new Error("candidate no longer matches thread status");
			candidate.status = event.type === "candidate.confirmed" ? "confirmed" : "rejected";
			candidate.actedBy = (event.actor as Member).handle;
			if (event.type === "candidate.confirmed") {
				if (candidate.kind === "resolution") {
					let decision: ConversationPlan.Decision = {
						id: event.id,
						text: candidate.text,
						sources: candidate.sources,
						actor: event.actor as Member,
						at: event.at,
					};
					thread.decision = decision;
					thread.decisionHistory.push(decision);
					thread.status = "decided";
				} else {
					thread.decision = undefined;
					thread.status = "reopened";
				}
			}
			break;
		}
		case "card.linked":
			if (thread.questionnaireId) throw new Error("thread already has a card");
			thread.questionnaireId = event.questionnaireId;
			break;
		case "thread.discarded":
			thread.status = "discarded";
			thread.pendingSettle = undefined;
			thread.pendingScopedChoice = undefined;
			break;
	}
}
