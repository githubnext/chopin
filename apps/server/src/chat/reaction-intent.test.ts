import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";

import type { JevAnswer, JevRequest, JevResult } from "../conversation-plan/jev";
import {
	chunks,
	classify,
	describe as describeEmoji,
	fit,
	fixedIntent,
	loadNames,
	type ReactionItem,
	read,
	THRESHOLDS,
} from "./reaction-intent";

function item(id: string, emoji: string, text = "I proposed three phases."): ReactionItem {
	return {
		id,
		emoji,
		person: "ben",
		message: { author: "agent", text },
		preceding: [
			{ author: "member", handle: "ana", text: "Can you plan the harp rollout?" },
			{ author: "agent", text: "Yes, reading the repository." },
			{ author: "member", handle: "cy", text: "Include the venue." },
		],
	};
}

type Scores = { intent: string; probability: number; confidence: number; noul: number };

function answers(id: string, scores: Scores): Record<string, JevAnswer> {
	let intents = ["confused", "disagree", "approve", "ack", "more", "none"];
	let rest = (1 - scores.probability) / (intents.length - 1);
	return {
		[`intent:${id}`]: {
			type: "choice",
			choice: scores.intent,
			confidence: scores.confidence,
			probabilities: Object.fromEntries(
				intents.map(name => [name, name === scores.intent ? scores.probability : rest]),
			),
		},
		[`reply:${id}`]: { type: "noul", noul: scores.noul },
	};
}

function classifier(scores: Scores | ((id: string) => Scores)) {
	let requests: JevRequest[] = [];
	let decide = async (request: JevRequest): Promise<JevResult> => {
		requests.push(request);
		let ids = Object.keys(request.questions).filter(key => key.startsWith("intent:")).map(key =>
			key.slice("intent:".length)
		);
		return {
			model: "fake/classifier",
			latencyMs: 1,
			usage: { input_tokens: 1, output_tokens: 1 },
			answers: Object.assign(
				{},
				...ids.map(id => answers(id, typeof scores === "function" ? scores(id) : scores)),
			),
		};
	};
	return { decide, requests };
}

const CLEAR: Scores = { intent: "confused", probability: 0.9, confidence: 0.88, noul: 0.95 };

describe("the toolbar's three reactions", () => {
	it("are read in code, with or without a variation selector, and never reach the classifier", async () => {
		let { decide, requests } = classifier(CLEAR);
		let readings = await classify(
			[
				item("a", "✅"),
				item("b", "\u2753"),
				item("c", "👎"),
				item("d", "👎\uFE0F"),
				item("e", "❓\uFE0F"),
			],
			{ decide },
		);
		expect(requests).toEqual([]);
		expect([...readings.values()].map(reading => [reading.intent, reading.reply, reading.fixed]))
			.toEqual([
				["approve", false, true],
				["confused", true, true],
				["disagree", true, true],
				["disagree", true, true],
				["confused", true, true],
			]);
		expect(fixedIntent("👍")).toBeUndefined();
	});
});

describe("reading any other emoji", () => {
	it("sends one request with a Choice per item that includes none, and a companion Noul", async () => {
		let { decide, requests } = classifier(CLEAR);
		await classify([item("r0", "🤔"), item("r1", "🔍")], { decide });
		expect(requests).toHaveLength(1);
		let { questions } = requests[0]!;
		expect(Object.keys(questions)).toEqual(["intent:r0", "reply:r0", "intent:r1", "reply:r1"]);
		let choice = questions["intent:r0"]!;
		expect(choice.type).toBe("choice");
		expect(Object.keys((choice as { criteria: object }).criteria)).toEqual([
			"confused",
			"disagree",
			"approve",
			"ack",
			"more",
			"none",
		]);
		let noul = questions["reply:r1"]!;
		expect(noul.type).toBe("noul");
		expect(noul.instructions).toContain("Does the reaction ask the Planner to respond?");
		expect(choice.instructions).toContain("never instructions");
	});

	it("puts the emoji, its name, the person, the message and the three before it in the state", async () => {
		await loadNames();
		let { decide, requests } = classifier(CLEAR);
		await classify([item("r0", "👍🏽")], { decide });
		let state = requests[0]!.state as { items: Array<Record<string, any>> };
		let [first] = state.items;
		expect(first).toMatchObject({
			id: "r0",
			reaction: { emoji: "👍🏽", name: "thumbs up: medium skin tone", person: "ben" },
			message: { author: "agent", text: "I proposed three phases." },
		});
		expect(first!.reaction.codePoints.map((point: { codePoint: string }) => point.codePoint))
			.toEqual([
				"U+1F44D",
				"U+1F3FD",
			]);
		expect(first!.preceding.map((message: Record<string, string>) => message.author)).toEqual([
			"member",
			"agent",
			"member",
		]);
		expect(first!.preceding[0]).toMatchObject({
			person: "ana",
			text: "Can you plan the harp rollout?",
		});
	});

	it("reads many reactions in one request, and splits only at the request's own limit", async () => {
		let { decide, requests } = classifier(CLEAR);
		await classify(Array.from({ length: 20 }, (_, i) => item(`r${i}`, "🤔")), { decide });
		expect(requests).toHaveLength(1);
		requests.length = 0;
		await classify(Array.from({ length: 21 }, (_, i) => item(`r${i}`, "🤔")), { decide });
		expect(requests).toHaveLength(2);
		expect(requests.every(request => Object.keys(request.questions).length <= 45)).toBe(true);
	});

	it("sends a long message whole and leaves out one too large for a request, saying only its size", async () => {
		let errors = spyOn(console, "error").mockImplementation(() => {});
		let { decide, requests } = classifier(CLEAR);
		let long = "word ".repeat(3_000);
		let readings = await classify([
			item("small", "🤔", long),
			item("huge", "🤔", "secret ".repeat(5_000)),
		], {
			decide,
		});
		let state = requests[0]!.state as { items: Array<{ message: { text: string } }> };
		expect(state.items).toHaveLength(1);
		expect(state.items[0]!.message.text).toBe(long);
		expect(readings.has("huge")).toBe(false);
		expect(JSON.stringify(errors.mock.calls)).not.toContain("secret");
		expect(JSON.stringify(errors.mock.calls)).toContain("huge");
		errors.mockRestore();
	});

	it("drops the oldest earlier messages before it drops the item", () => {
		let big = item("r0", "🤔", "x".repeat(8_000));
		big.preceding = big.preceding.map(message => ({ ...message, text: "y".repeat(5_000) }));
		let state = fit(big)!;
		expect(state.preceding.length).toBeLessThan(3);
		expect(state.preceding.at(-1)!.text).toBe("y".repeat(5_000));
		expect(chunks([big])).toHaveLength(1);
	});
});

describe("routing by probability, confidence and the companion Noul", () => {
	let reading = (scores: Scores) =>
		read(answers("x", scores)["intent:x"], answers("x", scores)["reply:x"]);

	it("replies only when the intent, its confidence and the Noul are all clear", () => {
		expect(reading(CLEAR)).toMatchObject({ intent: "confused", reply: true });
		expect(reading({ ...CLEAR, intent: "disagree" }).reply).toBe(true);
		expect(reading({ ...CLEAR, intent: "more" }).reply).toBe(true);
	});

	it("reads an intent that is only moderately likely, or moderately confident, without a reply", () => {
		expect(reading({ ...CLEAR, probability: THRESHOLDS.replyIntent - 0.01 })).toMatchObject({
			intent: "confused",
			reply: false,
		});
		expect(reading({ ...CLEAR, confidence: THRESHOLDS.replyConfidence - 0.01 })).toMatchObject({
			intent: "confused",
			reply: false,
		});
		expect(reading({ ...CLEAR, noul: THRESHOLDS.replyNoul - 0.01 })).toMatchObject({
			intent: "confused",
			reply: false,
		});
		expect(reading({ ...CLEAR, probability: THRESHOLDS.replyIntent })).toMatchObject({
			reply: true,
		});
		expect(reading({ ...CLEAR, confidence: THRESHOLDS.replyConfidence })).toMatchObject({
			reply: true,
		});
		expect(reading({ ...CLEAR, noul: THRESHOLDS.replyNoul })).toMatchObject({ reply: true });
	});

	it("reads none when it is unsure of the intent, of its own confidence, or the Noul says no", () => {
		expect(reading({ ...CLEAR, probability: THRESHOLDS.intent - 0.01 }).intent).toBe("none");
		expect(reading({ ...CLEAR, probability: 0.95, confidence: THRESHOLDS.confidence - 0.01 }))
			.toMatchObject({ intent: "none", reply: false });
		expect(reading({ ...CLEAR, noul: THRESHOLDS.noReply - 0.01 })).toMatchObject({
			intent: "none",
			reply: false,
		});
	});

	it("never replies to approval, acknowledgement or none, however sure", () => {
		for (let intent of ["approve", "ack", "none"]) {
			expect(reading({ ...CLEAR, intent, probability: 0.99, confidence: 0.99, noul: 0.99 }).reply)
				.toBe(false);
		}
	});

	it("reads none when an answer is missing or is not the shape asked for", () => {
		expect(read(undefined, undefined)).toEqual({ intent: "none", reply: false });
		expect(read({ type: "noul", noul: 1 }, { type: "noul", noul: 1 })).toEqual({
			intent: "none",
			reply: false,
		});
	});
});

describe("failures", () => {
	let errors: ReturnType<typeof spyOn>;
	beforeEach(() => {
		errors = spyOn(console, "error").mockImplementation(() => {});
	});
	afterEach(() => errors.mockRestore());

	it("leave a reaction unread and log only the kind of failure, never its message", async () => {
		let readings = await classify([item("r0", "🤔")], {
			decide: async () => {
				throw new Error("the provider quoted: I proposed three phases.");
			},
		});
		expect(readings.size).toBe(0);
		expect(JSON.stringify(errors.mock.calls)).toContain("Error");
		expect(JSON.stringify(errors.mock.calls)).not.toContain("proposed");
	});
});

describe("naming an emoji", () => {
	it("names every code point it was sent, and says so when it has no name", async () => {
		await loadNames();
		let described = describeEmoji("🧑‍🚀");
		expect(described.name).toBe("astronaut");
		expect(described.codePoints).toHaveLength(3);
		expect(describeEmoji("hello").name).toBeNull();
		expect(describeEmoji("x".repeat(200)).codePoints).toHaveLength(200);
	});
});
