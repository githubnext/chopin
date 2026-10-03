import { expect, test } from "bun:test";
import { buildCandidateTargetingRequest } from "./questions";
import { fourCandidates, threadWithStatus } from "./question-builder.test-fixtures";

// Original callbacks: archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2, questions.test.ts.
// Final parameterized interpreter callback (two cases) awaits the interpreter/policy slice.

test("four-span targeting keeps prompts for reopening a discarded thread", () => {
	let { current, candidates } = fourCandidates();
	let request = buildCandidateTargetingRequest(
		current,
		[],
		[threadWithStatus("discarded")],
		candidates,
		3,
	);

	expect(request.questions.c3_raises_again?.type).toBe("noul");
	expect(request.questions.c3_reopening?.type).toBe("noul");
	expect(request.questions.c3_material_objection?.type).toBe("noul");
});

test("four-span targeting keeps prompts for reopening a decided thread", () => {
	let { current, candidates } = fourCandidates();
	let request = buildCandidateTargetingRequest(
		current,
		[],
		[threadWithStatus("decided")],
		candidates,
		3,
	);

	expect(request.questions.c3_reopening?.type).toBe("noul");
	expect(request.questions.c3_material_objection?.type).toBe("noul");
});

test("four-span pending-settle targeting includes relation and its qualifier within 45 answers", () => {
	let { current, candidates } = fourCandidates();
	let pendingThread = {
		...threadWithStatus("exploring"),
		contributions: [{
			id: "oauth",
			kind: "option" as const,
			text: "GitHub OAuth",
			authoring: "quoted" as const,
			sources: [],
			actor: { kind: "classifier" as const },
		}],
		pendingSettle: { optionId: "oauth", proposer: "Mina", messageId: "proposal" },
	};
	let requests = candidates.map((_, index) =>
		buildCandidateTargetingRequest(current, [], [pendingThread], candidates, index)
	);
	let persistedAnswerCount = requests.reduce(
		(count, request) => count + Object.keys(request.questions).length,
		0,
	);

	expect(requests[2]!.questions.c2_relation?.type).toBe("choice");
	expect(requests[2]!.questions.c2_qualifies_pending_settle?.type).toBe("noul");
	expect(
		requests.flatMap(request => Object.keys(request.questions)).filter(key =>
			key.endsWith("_duplicate")
		),
	).toEqual([]);
	expect(persistedAnswerCount).toBe(44);
});
