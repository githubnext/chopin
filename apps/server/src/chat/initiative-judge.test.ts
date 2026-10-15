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
		turn: { group: true, quiet: true, paused: false },
		document: "# Shared document\nWe are exploring collaborative writing.",
		unanswered: [],
	};
}

function options(
	choice: InitiativeMove | "wait" = "respond",
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
				["wait", "respond", "yield", "direct"].map(move => [
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

test.each(["respond", "direct"] as const)(
	"returns %s only when its winning probability clears the threshold",
	async move => {
		expect(await judgeInitiative(context(), options(move, 0.75))).toBe(move);
		expect(await judgeInitiative(context(), options(move, 0.749, 1))).toBeUndefined();
	},
);

test("uses the winning probability rather than normalized confidence", async () => {
	expect(await judgeInitiative(context(), options("respond", 0.8, 0.1))).toBe("respond");
	expect(await judgeInitiative(context(), options("respond", 0.6, 1))).toBeUndefined();
});

test("a confident wait result never starts a turn", async () => {
	expect(await judgeInitiative(context(), options("wait", 1, 1))).toBeUndefined();
});

test("missing, empty, non-human and uninspectably long sources stay quiet without a call", async () => {
	let fetches = 0;
	let injection = options("respond", 1, 1, () => fetches++);
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
	let injection = options("respond", 1, 1, request => {
		captured = request;
	});
	expect(await judgeInitiative(input, injection)).toBe("respond");
	expect(captured).toBeDefined();
	expect(JSON.stringify(captured!.state).length).toBeLessThan(24000);
	let state = captured!.state as InitiativeContext;
	expect(state.messages.length).toBeLessThanOrEqual(10);
	expect(state.unanswered.length).toBeLessThanOrEqual(4);
	expect(state.messages.find(message => message.id === "source")?.text)
		.toBe(input.messages.at(-1)!.text);
	expect(state.messages.at(-1)?.id).toBe("source");
});

test("a reply after the source consumes the opportunity without a judgment", async () => {
	let input = context();
	input.messages.push({ id: "reply", author: "agent", text: "Answered." });
	let fetches = 0;
	expect(await judgeInitiative(input, options("respond", 1, 1, () => fetches++))).toBeUndefined();
	expect(fetches).toBe(0);
});

test("solo human messages get replies without any semantic service call", async () => {
	for (let text of ["Hello", "That makes sense", "Tell me more", "x".repeat(10000)]) {
		let input = context();
		input.turn = { group: false, quiet: false, paused: false };
		input.messages[1]!.text = text;
		let fetches = 0;
		expect(await judgeInitiative(input, options("wait", 1, 1, () => fetches++))).toBe("respond");
		expect(fetches).toBe(0);
	}
});

test("group yield gets a quiet-window reconsideration, but never a repeating timer", async () => {
	let input = context();
	input.turn.quiet = false;
	expect(await judgeInitiative(input, options("yield", 0.9))).toBe("yield");
	expect(await judgeInitiative(input, options("respond", 0.6))).toBe("yield");
	input.turn.quiet = true;
	expect(await judgeInitiative(input, options("yield", 0.9))).toBeUndefined();
});

test("paused conversation admits only a confident direct request", async () => {
	let input = context();
	input.turn = { group: false, quiet: false, paused: true };
	expect(await judgeInitiative(input, options("respond", 1))).toBeUndefined();
	expect(await judgeInitiative(input, options("yield", 1))).toBeUndefined();
	expect(await judgeInitiative(input, options("direct", 0.74))).toBeUndefined();
	expect(await judgeInitiative(input, options("direct", 0.75))).toBe("direct");
});

test("transport failures and malformed results stay quiet", async () => {
	for (
		let injectedFetch of [
			async () => {
				throw new Error("unavailable");
			},
			async () => new Response("offline", { status: 503 }),
			async () => Response.json({ answers: { initiative: { choice: "direct" } } }),
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

test.each(["respond", "direct"] as const)(
	"%s instruction limits the Planner to one provisional conversational move",
	move => {
		let instruction = initiativeInstruction(move, "source");
		expect(instruction).toContain('"source"');
		expect(instruction).toContain("current source");
		expect(instruction).toContain("one concise final conversational reply");
		expect(instruction).toContain("human choices");
		expect(instruction).toContain("without separate progress messages");
		expect(instruction).toContain("do not invent another turn");
		expect(instruction.length).toBeLessThan(1200);
	},
);

test("focused child conversation admits only direct requests and preserves the source after tool-only entries", async () => {
	let input = context();
	input.turn = { group: false, quiet: false, paused: false, focused: true };
	input.messages.push({ id: "tool-only", author: "agent", text: "" });
	expect(await judgeInitiative(input, options("respond", 1))).toBeUndefined();
	expect(await judgeInitiative(input, options("direct", 1))).toBe("direct");
	input.turn.focused = false;
	expect(await judgeInitiative(input, options("wait", 1))).toBe("respond");
});
