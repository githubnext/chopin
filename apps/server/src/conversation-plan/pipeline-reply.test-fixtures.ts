import type { JevQuestion } from "./jev";

export let question: Record<string, JevQuestion> = {
	flag: { type: "noul", instructions: "Does current.text ask?" },
	act: { type: "choice", instructions: "What act?", criteria: { yes: "Yes", no: "No" } },
	level: { type: "score", instructions: "How much?", criteria: ["None", "Some", "All"] },
};

export let validAnswers = {
	flag: { type: "noul", noul: 0.8 },
	act: { type: "choice", choice: "yes", confidence: 0.9, probabilities: { yes: 0.9, no: 0.1 } },
	level: {
		type: "score",
		score: 1.8,
		confidence: 0.8,
		legend: { "0": "None", "1": "Some", "2": "All" },
		probabilities: { "0": 0.1, "1": 0, "2": 0.9 },
	},
};

export let reply = (answers: unknown) =>
	new Response(
		JSON.stringify({ model: "jev-1.13.0", answers, usage: { input_tokens: 10, output_tokens: 2 } }),
		{ status: 200 },
	);
