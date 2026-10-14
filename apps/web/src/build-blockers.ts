import { cardStatus } from "@chopin/dialect";

import type { QuestionnaireEntry } from "@chopin/editor";
import type { Question } from "@chopin/protocol";
import type { ImplementationSnapshot } from "@chopin/protocol/implementation";

export type BuildBlocker =
	| { kind: "decision"; id: string; question: string; title: string }
	| { kind: "investigation"; id: string; title: string };

export function buildBlockers(
	snapshot: ImplementationSnapshot | undefined,
	entries: QuestionnaireEntry[],
	metadata: ReadonlyMap<string, Question.CardMeta>,
): BuildBlocker[] {
	if (!snapshot) return [];
	let items: BuildBlocker[] = [];
	if (snapshot.blockers.includes("unanswered questionnaires")) {
		for (let entry of entries) {
			let status = metadata.get(entry.id)?.status ?? cardStatus(entry.value);
			if (status !== "open" && status !== "reopened") continue;
			for (let question of entry.value.questions) {
				if (status !== "reopened" && question.answer !== undefined) continue;
				items.push({
					kind: "decision",
					id: entry.id,
					question: question.id,
					title: question.prompt,
				});
			}
		}
	}
	for (let investigation of snapshot.buildInvestigations ?? []) {
		items.push({ kind: "investigation", id: investigation.id, title: investigation.brief });
	}
	return items;
}

export function buildBlockerSummary(items: readonly BuildBlocker[]) {
	let decisions = items.filter(item => item.kind === "decision").length;
	let investigations = items.length - decisions;
	if (decisions && investigations) {
		return { tone: "mixed" as const, label: `${items.length} blockers left` };
	}
	let tone = decisions ? "decision" as const : "investigation" as const;
	return { tone, label: `${items.length} ${tone}${items.length === 1 ? "" : "s"} left` };
}
