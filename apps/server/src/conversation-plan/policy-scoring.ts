import type { JevAnswer } from "./jev";

export function noul(answers: Record<string, JevAnswer>, key: string): number {
	let answer = answers[key];
	return answer?.type === "noul" ? answer.noul : 0;
}
export function choice(answers: Record<string, JevAnswer>, key: string): string | undefined {
	let answer = answers[key];
	if (answer?.type !== "choice") return;
	let ranked = Object.values(answer.probabilities).sort((a, b) => b - a);
	if ((ranked[0] ?? 0) < 0.8 || (ranked[0] ?? 0) - (ranked[1] ?? 0) < 0.2) return;
	return answer.choice;
}
export function moderateChoice(
	answers: Record<string, JevAnswer>,
	key: string,
	expected: string,
	minimum: number,
): boolean {
	let answer = answers[key];
	if (answer?.type !== "choice" || answer.choice !== expected || answer.confidence < 0.5) {
		return false;
	}
	let probability = answer.probabilities[expected] ?? 0;
	let other = Math.max(
		0,
		...Object.entries(answer.probabilities)
			.filter(([name]) => name !== expected).map(([, value]) => value),
	);
	return probability >= minimum && probability - other >= 0.2;
}
export function roleChoice(
	answers: Record<string, JevAnswer>,
	first: Record<string, JevAnswer>,
	pendingAgreement = false,
): string | undefined {
	let answer = answers.role;
	if (answer?.type !== "choice") return;
	let role = answer.choice;
	if (["question", "resolution", "reopening", "none"].includes(role)) {
		return choice(answers, "role");
	}
	let significance = first.significance;
	if (significance?.type === "score" && significance.score < 1) return;
	let corroboration: Record<string, [string, number]> = {
		option: ["new_option", 0.75],
		reason: ["planning_substance", 0.7],
		constraint: ["planning_substance", 0.65],
		support: ["support", 0.65],
		objection: ["objection", 0.55],
	};
	let requirement = corroboration[role];
	let strength = role === "support" && pendingAgreement
		? Math.max(noul(answers, "support"), noul(answers, "agrees_with_settle"))
		: requirement
		? noul(answers, requirement[0])
		: 0;
	if (!requirement || strength < requirement[1]) return;
	let ranked = Object.values(answer.probabilities).sort((a, b) => b - a);
	if ((ranked[0] ?? 0) < 0.55 || (ranked[0] ?? 0) - (ranked[1] ?? 0) < 0.1) return;
	return role;
}
