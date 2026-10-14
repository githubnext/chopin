import type { TranscriptTurn, Turn } from "./types";

/** Copilot's disposable native turns need the same bounded Chat bootstrap as hosted turns. */
export function turnPrompt(previous: TranscriptTurn[], current: Turn): string {
	let entries = previous.flatMap(turn => [
		`@${turn.human.speaker}: ${turn.human.text}`,
		...(turn.text ? [`Planner: ${turn.text}`] : []),
	]).slice(-100);
	let retained: string[] = [];
	let size = 0;
	for (let entry of entries.toReversed()) {
		if (size + entry.length + 1 > 50_000) {
			if (!retained.length) retained.unshift(entry.slice(-50_000));
			break;
		}
		retained.unshift(entry);
		size += entry.length + 1;
	}
	return [
		retained.length ? `Durable conversation context follows:\n${retained.join("\n")}` : "",
		`Current addressed message:\n@${current.speaker}: ${current.text}`,
	].filter(Boolean).join("\n\n");
}

export function leaseDuration(turnCount: number, turnTimeoutMs: number): number {
	return 90_000 + turnCount * (turnTimeoutMs + 5_000);
}
