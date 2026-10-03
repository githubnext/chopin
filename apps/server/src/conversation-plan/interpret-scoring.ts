import type { JevAnswer } from "./jev";

export function noul(answers: Record<string, JevAnswer>, key: string): number {
	let answer = answers[key];
	return answer?.type === "noul" ? answer.noul : 0;
}
export function score(answers: Record<string, JevAnswer>, key: string): number {
	let answer = answers[key];
	return answer?.type === "score" ? answer.score : 0;
}
export function confidentChoice(
	answers: Record<string, JevAnswer>,
	key: string,
): string | undefined {
	let answer = answers[key];
	if (answer?.type !== "choice") return;
	let ranked = Object.values(answer.probabilities).sort((a, b) => b - a);
	if (
		answer.confidence < 0.8 || (ranked[0] ?? 0) < 0.8
		|| (ranked[0] ?? 0) - (ranked[1] ?? 0) < 0.2
	) return;
	return answer.choice;
}
