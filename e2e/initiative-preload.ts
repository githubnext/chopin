/** Only the judgment HTTP boundary is fake; scheduler, authorization and turns are real. */
import type { JevQuestion, JevRequest } from "../apps/server/src/conversation-plan/jev";
import { authoringJudgment } from "./authoring-judgments";

let network = globalThis.fetch;
let fake = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
	let url = new URL(input instanceof Request ? input.url : input);
	if (url.hostname !== "api.typesafe.ai") return network(input, init);
	if (url.href !== "https://api.typesafe.ai/v1/systemone" || init?.method !== "POST") {
		return Response.json({ error: "unexpected initiative judgment request" }, { status: 501 });
	}
	if (new Headers(init.headers).get("authorization") !== "Bearer e2e-jev-only") {
		return Response.json({ error: "unexpected initiative judgment credential" }, { status: 401 });
	}
	let request = JSON.parse(String(init.body)) as JevRequest;
	let authoring = authoringJudgment(request);
	if (authoring) return Response.json(authoring);
	if (request.questions.build_ready?.type === "noul") {
		return Response.json({
			model: "jev-e2e-initiative",
			answers: { build_ready: { type: "noul", noul: 0.03 } },
			usage: { input_tokens: 10, output_tokens: 5 },
		});
	}
	let question = request.questions.initiative;
	if (Object.keys(request.questions).length !== 1 || question?.type !== "choice") {
		return Response.json({ error: "unexpected initiative judgment question" }, { status: 501 });
	}
	let state = request.state as {
		sourceId: string;
		turn: { group: boolean; quiet: boolean; paused: boolean; focused?: boolean };
		messages: Array<{ id: string; author: string; text: string }>;
	};
	let source = state.messages.find(message => message.id === state.sourceId);
	let answer = source?.text.startsWith("Chopin, can you")
		? "direct"
		: state.turn.paused || state.turn.focused || source?.text.startsWith("Please wait")
		? "wait"
		: state.turn.group && !state.turn.quiet
		? "yield"
		: "respond";
	return Response.json({
		model: "jev-e2e-initiative",
		answers: { initiative: choice(question, answer) },
		usage: { input_tokens: 10, output_tokens: 5 },
	});
};

function choice(question: Extract<JevQuestion, { type: "choice" }>, answer: string) {
	let keys = Object.keys(question.criteria);
	return {
		type: "choice",
		choice: answer,
		confidence: 0.98,
		probabilities: Object.fromEntries(keys.map(key => [
			key,
			key === answer ? 0.98 : 0.02 / (keys.length - 1),
		])),
	};
}

globalThis.fetch = Object.assign(fake, { preconnect: network.preconnect });
