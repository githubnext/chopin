import { expect, test } from "bun:test";
import type { JevOptions, JevRequest } from "../conversation-plan/jev";
import {
	type InitiativeContext,
	initiativeInstruction,
	type InitiativeMove,
	judgeInitiative,
} from "./initiative-judge";

function context(): InitiativeContext {
	return {
		messages: [
			{ id: "before", author: "member", handle: "ana", text: "Could decisions help here?" },
			{
				id: "source",
				author: "member",
				handle: "bo",
				text: "I don't understand what a decision means in this document.",
			},
		],
		sourceId: "source",
		document: "# Shared document\nWe are exploring collaborative writing.",
		unanswered: [],
	};
}

function options(
	choice: InitiativeMove | "wait" = "clarify",
	winningProbability = 0.8,
	confidence = 0.1,
	inspect?: (request: JevRequest) => void,
): JevOptions {
	return {
		apiKey: "test-key",
		fetch: async (_input, init) => {
			let request = JSON.parse(String(init?.body)) as JevRequest;
			inspect?.(request);
			let probabilities = Object.fromEntries(
				["wait", "clarify", "investigate", "recommend"].map(move => [
					move,
					move === choice ? winningProbability : (1 - winningProbability) / 3,
				]),
			);
			return Response.json({
				model: "jev-fixture",
				answers: { initiative: { type: "choice", choice, confidence, probabilities } },
				usage: { input_tokens: 1, output_tokens: 1 },
			});
		},
	};
}

test.each(["clarify", "investigate", "recommend"] as const)(
	"returns %s only when its winning probability clears the threshold",
	async move => {
		expect(await judgeInitiative(context(), options(move, 0.75))).toBe(move);
		expect(await judgeInitiative(context(), options(move, 0.749, 1))).toBeUndefined();
	},
);

test("uses the winning probability rather than normalized confidence", async () => {
	expect(await judgeInitiative(context(), options("clarify", 0.8, 0.1))).toBe("clarify");
	expect(await judgeInitiative(context(), options("clarify", 0.6, 1))).toBeUndefined();
});

test("a confident wait result never starts a turn", async () => {
	expect(await judgeInitiative(context(), options("wait", 1, 1))).toBeUndefined();
});

test("missing, empty, non-human and uninspectably long sources stay quiet without a call", async () => {
	let fetches = 0;
	let injection = options("clarify", 1, 1, () => fetches++);
	let missing = context();
	missing.sourceId = "missing";
	let empty = context();
	empty.messages[1]!.text = " \n ";
	let agent = context();
	agent.messages[1]!.author = "agent";
	let oversized = context();
	oversized.messages[1]!.text = "x".repeat(7000);
	let escaped = context();
	escaped.messages[1]!.text = "\u0000".repeat(1100);
	for (let input of [missing, empty, agent, oversized, escaped]) {
		expect(await judgeInitiative(input, injection)).toBeUndefined();
	}
	expect(fetches).toBe(0);
});

test("bounds the whole encoded state including escaping, identities and field names", async () => {
	let input = context();
	let huge = '\u0000\n"\\'.repeat(10000);
	input.messages.unshift(...Array.from({ length: 100 }, (_, i) => ({
		id: `old-${i}-${huge}`,
		author: "member" as const,
		handle: huge,
		text: huge,
	})));
	input.document = huge;
	input.unanswered = Array.from({ length: 100 }, () => ({ question: huge }));
	let captured: JevRequest | undefined;
	let injection = options("clarify", 1, 1, request => {
		captured = request;
	});
	expect(await judgeInitiative(input, injection)).toBe("clarify");
	expect(captured).toBeDefined();
	expect(JSON.stringify(captured!.state).length).toBeLessThan(24000);
	let state = captured!.state as InitiativeContext;
	expect(state.messages.length).toBeLessThanOrEqual(10);
	expect(state.unanswered.length).toBeLessThanOrEqual(4);
	expect(state.messages.find(message => message.id === "source")?.text)
		.toBe(input.messages.at(-1)!.text);
	expect(state.messages.at(-1)?.id).toBe("source");
});

test("the source survives a history window even when it is outside the recent tail", async () => {
	let input = context();
	input.messages.push(...Array.from({ length: 20 }, (_, i) => ({
		id: `later-${i}`,
		author: "agent" as const,
		text: "Earlier context.",
	})));
	let captured: JevRequest | undefined;
	await judgeInitiative(
		input,
		options("wait", 1, 1, request => {
			captured = request;
		}),
	);
	expect(captured).toBeDefined();
	let state = captured!.state as InitiativeContext;
	expect(state.messages[0]?.id).toBe("source");
	expect(state.messages.at(-1)?.id).toBe("later-19");
});

test("judgment defines quiet cases, meaningful replies and decision confusion", async () => {
	let captured: JevRequest | undefined;
	await judgeInitiative(
		context(),
		options("wait", 1, 1, request => {
			captured = request;
		}),
	);
	expect(captured).toBeDefined();
	expect(Object.keys(captured!.questions)).toEqual(["initiative"]);
	let question = captured!.questions.initiative!;
	expect(question.type).toBe("choice");
	if (question.type !== "choice") throw new Error("expected Choice");
	expect(Object.keys(question.criteria)).toEqual(["wait", "clarify", "investigate", "recommend"]);
	expect(question.instructions.length).toBeLessThanOrEqual(1000);
	for (
		let text of [
			"person-to-person",
			"requested waiting",
			"already settled",
			"acknowledges",
			"meaningful new human answer",
			"disagreement",
			"decision primitive",
		]
	) expect(question.instructions).toContain(text);
});

test("transport failures and malformed results stay quiet", async () => {
	for (
		let injectedFetch of [
			async () => {
				throw new Error("unavailable");
			},
			async () => new Response("offline", { status: 503 }),
			async () => Response.json({ answers: { initiative: { choice: "recommend" } } }),
		]
	) {
		expect(await judgeInitiative(context(), { apiKey: "test-key", fetch: injectedFetch }))
			.toBeUndefined();
	}
});

test("timeout and cancellation do not start a turn", async () => {
	expect(
		await judgeInitiative(context(), {
			apiKey: "test-key",
			timeoutMs: 100,
			fetch: () => new Promise(() => {}),
		}),
	).toBeUndefined();
	let controller = new AbortController();
	controller.abort();
	expect(await judgeInitiative(context(), { ...options(), signal: controller.signal }))
		.toBeUndefined();
});

test.each(["clarify", "investigate", "recommend"] as const)(
	"%s instruction limits the Planner to one provisional conversational move",
	move => {
		let instruction = initiativeInstruction(move, "source");
		expect(instruction).toContain('"source"');
		expect(instruction).toContain("current source");
		expect(instruction).toContain("one useful next move");
		expect(instruction).toContain("provisional");
		expect(instruction).toContain("human choices");
		expect(instruction).toContain("comprehensive questionnaire");
		expect(instruction).toContain("suggested UI solution");
		expect(instruction).toContain("stay quiet");
		expect(instruction.length).toBeLessThan(1200);
	},
);
