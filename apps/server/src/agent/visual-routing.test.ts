import { expect, test } from "bun:test";

import type { JevRequest, JevResult } from "../conversation-plan/jev";
import { assessVisual } from "./visual-routing";

function result(answers: JevResult["answers"], model = "jev-test"): JevResult {
	return { model, answers, usage: { input_tokens: 7, output_tokens: 2 }, latencyMs: 10 };
}

let passage = {
	index: 2,
	source: "Calling an async function returns a future. Polling advances its body.",
};

test("a passage Jev cannot visualize stops before the comprehension question", async () => {
	let requests: JevRequest[] = [];
	let assessed = await assessVisual(
		{ passages: [passage], readerQuestion: "When does the body run?" },
		async request => {
			requests.push(request);
			return result({ p2: { type: "noul", noul: 0.2 } });
		},
	);
	expect(requests).toHaveLength(1);
	expect(requests[0]!.questions.p2!.instructions).toContain("faithfully visualized");
	expect(assessed.routes).toEqual([{
		index: 2,
		kind: "prose",
		reason: "not-visualizable",
		possibility: 0.2,
	}]);
});

test("a possible visual with no explanatory gain stops before type choice", async () => {
	let calls = 0;
	let assessed = await assessVisual(
		{ passages: [passage], readerQuestion: "When does the body run?" },
		async () =>
			++calls === 1
				? result({ p2: { type: "noul", noul: 0.9 } })
				: result({ h2: { type: "noul", noul: 0.3 } }),
	);
	expect(calls).toBe(2);
	expect(assessed.routes).toEqual([{
		index: 2,
		kind: "prose",
		reason: "no-explanatory-gain",
		possibility: 0.9,
		helpfulness: 0.3,
	}]);
});

test("Jev chooses from all canonical types after two positive answers", async () => {
	let requests: JevRequest[] = [];
	let answers = [
		result({ p2: { type: "noul", noul: 0.8 } }),
		result({ h2: { type: "noul", noul: 0.7 } }),
		result({ t2: { type: "choice", choice: "flowchart", confidence: 0.7, probabilities: {} } }),
	];
	let assessed = await assessVisual(
		{ passages: [passage], readerQuestion: "When does the body run?" },
		async request => {
			requests.push(request);
			return answers[requests.length - 1]!;
		},
	);
	expect(requests).toHaveLength(3);
	expect(requests[1]!.questions.h2!.instructions).toContain("otherwise have to assemble");
	expect(Object.keys((requests[2]!.questions.t2 as { criteria: object }).criteria)).toHaveLength(
		44,
	);
	expect(assessed.routes).toEqual([{
		index: 2,
		kind: "diagram",
		type: "flowchart",
		possibility: 0.8,
		helpfulness: 0.7,
		confidence: 0.7,
	}]);
});

test("Jev none keeps an explicit reason rather than asking the Planner to choose", async () => {
	let calls = 0;
	let assessed = await assessVisual(
		{ passages: [passage], readerQuestion: "Explain this." },
		async () => {
			calls++;
			return calls === 1
				? result({ p2: { type: "noul", noul: 0.9 } })
				: calls === 2
				? result({ h2: { type: "noul", noul: 0.9 } })
				: result({ t2: { type: "choice", choice: "none", confidence: 0.6, probabilities: {} } });
		},
	);
	expect(assessed.routes[0]).toMatchObject({ kind: "prose", reason: "no-suitable-type" });
});

test("invalid Jev answers become an explicit unavailable route", async () => {
	let assessed = await assessVisual(
		{ passages: [passage], readerQuestion: "Explain this." },
		async () =>
			result({ p2: { type: "choice", choice: "flowchart", confidence: 1, probabilities: {} } }),
	);
	expect(assessed.routes).toEqual([{ index: 2, kind: "prose", reason: "assessment-unavailable" }]);
	expect(assessed.failure).toEqual({ stage: "possibility", reason: "invalid-response" });
});

test("a later Jev timeout preserves an earlier no answer", async () => {
	let calls = 0;
	let assessed = await assessVisual(
		{
			passages: [
				{ index: 1, source: "A single isolated claim." },
				{ index: 2, source: "A future is polled, then returns Pending or Ready." },
			],
			readerQuestion: "Explain the passage.",
		},
		async () => {
			calls++;
			if (calls === 1) {
				return result({
					p1: { type: "noul", noul: 0.2 },
					p2: { type: "noul", noul: 0.9 },
				});
			}
			throw new Error("Jev request timed out");
		},
	);
	expect(calls).toBe(2);
	expect(assessed.routes).toEqual([
		{ index: 1, kind: "prose", reason: "not-visualizable", possibility: 0.2 },
		{ index: 2, kind: "prose", reason: "assessment-unavailable" },
	]);
	expect(assessed.failure).toEqual({ stage: "helpfulness", reason: "timeout" });
});

test("oversized passages are rejected before Jev is called", async () => {
	let calls = 0;
	await expect(assessVisual(
		{ passages: [{ index: 0, source: "x".repeat(2_001) }], readerQuestion: "Explain this." },
		async () => {
			calls++;
			return result({});
		},
	)).rejects.toThrow("passage exceeds 2000 characters");
	expect(calls).toBe(0);
});
