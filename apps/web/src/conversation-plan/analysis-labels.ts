import type { ConversationPlan } from "@chopin/protocol";

export const SIGNALS: Record<string, string> = {
	new_question: "Question",
	new_option: "Option",
	reason: "Reason",
	constraint: "Constraint",
	evidence: "Evidence",
	assumption: "Assumption",
	support: "Support",
	objection: "Objection",
	correction: "Correction",
	explicit_resolution: "Resolution",
	reopening: "Reopening",
};

export function answerText(answer: ConversationPlan.AnalysisAnswer): string {
	if (answer.type === "noul") return `${Math.round(answer.noul * 100)}% signal`;
	if (answer.type === "choice") {
		return `${answer.choice.replaceAll("_", " ")} · ${
			Math.round(answer.confidence * 100)
		}% confidence`;
	}
	return `${answer.score} · ${Math.round(answer.confidence * 100)}% confidence${
		answer.legend[String(answer.score)] ? ` · ${answer.legend[String(answer.score)]}` : ""
	}`;
}

export function questionName(key: string): string {
	return key.replace(/^c(\d+)_/, (_, number: string) => `Excerpt ${Number(number) + 1} · `)
		.replaceAll("_", " ");
}
