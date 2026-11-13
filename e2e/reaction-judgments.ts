import type { JevRequest, JevResult } from "../apps/server/src/conversation-plan/jev";

const INTENTS = ["confused", "disagree", "approve", "ack", "more", "none"];

/**
 * Typical readings the deployed decisions classifier gave for these emojis on a Planner message
 * (their probability, with confidence a few points lower); anything else reads as none.
 */
const READINGS: Record<string, { intent: string; probability: number }> = {
	"🤔": { intent: "confused", probability: 0.86 },
	"😕": { intent: "confused", probability: 0.95 },
	"🙋": { intent: "more", probability: 0.88 },
	"🔍": { intent: "more", probability: 0.9 },
	"👍": { intent: "approve", probability: 0.97 },
	"🙌": { intent: "approve", probability: 0.95 },
	"👀": { intent: "ack", probability: 0.96 },
};

export function reactionJudgment(
	request: JevRequest,
): Omit<JevResult, "latencyMs"> | undefined {
	let state = request.state as {
		items?: Array<{ id: string; reaction: { emoji: string } }>;
	};
	let ids = Object.keys(request.questions).filter(key => key.startsWith("intent:"));
	if (!ids.length || !Array.isArray(state?.items)) return;
	let answers: JevResult["answers"] = {};
	for (let key of ids) {
		let id = key.slice("intent:".length);
		let item = state.items.find(value => value.id === id);
		let reading = READINGS[item?.reaction.emoji.replaceAll("\uFE0F", "") ?? ""]
			?? { intent: "none", probability: 0.6 };
		answers[key] = {
			type: "choice",
			choice: reading.intent,
			confidence: reading.probability - 0.03,
			probabilities: Object.fromEntries(
				INTENTS.map(name => [
					name,
					name === reading.intent
						? reading.probability
						: (1 - reading.probability) / (INTENTS.length - 1),
				]),
			),
		};
	}
	return {
		model: "jev-e2e-reactions",
		answers,
		usage: { input_tokens: 10, output_tokens: 5 },
	};
}
