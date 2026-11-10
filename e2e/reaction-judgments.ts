import type { JevRequest, JevResult } from "../apps/server/src/conversation-plan/jev";

const INTENTS = ["confused", "disagree", "approve", "ack", "more", "none"];

const READINGS: Record<string, { intent: string; reply: number }> = {
	"🤔": { intent: "confused", reply: 0.96 },
	"🔍": { intent: "more", reply: 0.96 },
	"👍": { intent: "approve", reply: 0.04 },
	"🙌": { intent: "approve", reply: 0.04 },
	"👀": { intent: "ack", reply: 0.04 },
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
			?? { intent: "none", reply: 0.02 };
		answers[key] = {
			type: "choice",
			choice: reading.intent,
			confidence: 0.94,
			probabilities: Object.fromEntries(
				INTENTS.map(name => [name, name === reading.intent ? 0.95 : 0.05 / (INTENTS.length - 1)]),
			),
		};
		answers[`reply:${id}`] = { type: "noul", noul: reading.reply };
	}
	return {
		model: "jev-e2e-reactions",
		answers,
		usage: { input_tokens: 10, output_tokens: 5 },
	};
}
