import type { Agenda } from "@chopin/protocol";

export let stopReasons: Record<Agenda.StopReason, string> = {
	"human-paused": "Paused. Running research has been cancelled.",
	"scope-changed": "Scope saved. Allow public research to continue with this scope.",
	"restart": "Paused after a restart. Allow public research to continue.",
	"owner-unavailable": "Stopped because the person who allowed research is unavailable.",
	"capability-unavailable": "Stopped because bounded research is unavailable.",
	"expired": "The 24-hour permission has ended.",
	"budget-exhausted": "Stopped at the research budget.",
	"investigations-complete": "The allowed investigations are complete.",
	"evidence-sufficient": "Stopped because there is enough evidence for this scope.",
	"nothing-useful": "No useful investigation remains in this scope.",
	"assessment-failed": "Question selection failed. Review the scope before allowing more research.",
	"research-failed": "An investigation failed. Review the questions before allowing more research.",
	"research-cancelled": "An investigation was cancelled. Research has stopped.",
	"research-timeout": "An investigation reached its time limit. Research has stopped.",
	"document-unavailable": "Research stopped because the document is unavailable.",
};

export type DraftQuestion = Agenda.QuestionInput & { key: string };
export type Draft = { revision: number; scope: string; questions: DraftQuestion[] };

export function draftFrom(agenda: Agenda.View | null): Draft {
	return {
		revision: agenda?.revision ?? 0,
		scope: agenda?.scope ?? "",
		questions: agenda?.questions.map(question => ({
			key: question.id,
			question: question.question,
			reason: question.reason,
			evidenceNeed: question.evidenceNeed,
			priority: question.priority,
		})) ?? [],
	};
}

export function validDraft(draft: Draft): boolean {
	return draft.scope.trim().length >= 20 && draft.scope.length <= 2000
		&& draft.questions.every(question =>
			question.question.trim().length >= 8 && question.question.length <= 500
			&& question.reason.trim().length >= 1 && question.reason.length <= 300
			&& question.evidenceNeed.trim().length >= 1 && question.evidenceNeed.length <= 500
		);
}
