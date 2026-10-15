import { afterEach, describe, expect, test } from "bun:test";
import { createDecide, decisionsRegistry, openDecisions } from "./decisions";
import { fakeRegistry } from "./decisions.test-fixtures";

import type { JevRequest } from "./jev";

let request: JevRequest = {
	state: { text: "Synthetic" },
	questions: {
		flag: { type: "noul", instructions: "Is this true?" },
		named: {
			type: "noul",
			instructions: "Is it named?",
			criteria: { true: "A name appears", false: "No name appears" },
		},
		action: { type: "choice", instructions: "Choose", criteria: { save: "Save", skip: "Skip" } },
		strength: { type: "score", instructions: "Rate", criteria: ["Low", "Some", "High"] },
	},
};
let answers = {
	flag: { type: "bool", probability: 0.9 },
	named: { type: "bool", probability: 0.2 },
	action: {
		type: "choice",
		choice: "save",
		confidence: 0.8,
		probabilities: { save: 0.85, skip: 0.15 },
	},
	strength: { type: "score", score: 1.1, confidence: 0.55 },
};
let settings = { model: "typesafe/jev-latest", timeoutMs: 30_000 };

describe("decide", () => {
	test("asks the configured classifier once with Chopin's questions in Atomic's shape", async () => {
		let registry = fakeRegistry(() => ({
			answers: answers as any,
			usage: {
				input: 12,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 12,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		}));
		let result = await createDecide(registry, settings)(request);
		expect(registry.calls).toHaveLength(1);
		let [call] = registry.calls;
		expect(call.model).toEqual({ provider: "typesafe", id: "jev-latest" });
		expect(call.context).toEqual({
			state: { text: "Synthetic" },
			questions: {
				flag: {
					type: "bool",
					instructions: "Is this true?",
					criteria: { true: "Yes", false: "No" },
				},
				named: {
					type: "bool",
					instructions: "Is it named?",
					criteria: { true: "A name appears", false: "No name appears" },
				},
				action: {
					type: "choice",
					instructions: "Choose",
					criteria: { save: "Save", skip: "Skip" },
				},
				strength: { type: "score", instructions: "Rate", criteria: ["Low", "Some", "High"] },
			},
		});
		expect(call.options?.maxRetries).toBe(0);
		expect(call.options?.signal).toBeInstanceOf(AbortSignal);
		expect(result).toMatchObject({
			model: "jev-latest",
			usage: { input_tokens: 12, output_tokens: 0 },
			answers: {
				flag: { type: "noul", noul: 0.9 },
				named: { type: "noul", noul: 0.2 },
				action: {
					type: "choice",
					choice: "save",
					confidence: 0.8,
					probabilities: { save: 0.85, skip: 0.15 },
				},
				strength: {
					type: "score",
					score: 1.1,
					confidence: 0.55,
					legend: { "0": "Low", "1": "Some", "2": "High" },
				},
			},
		});
		expect(result.answers.strength).not.toHaveProperty("probabilities");
		expect(result.latencyMs).toBeGreaterThanOrEqual(0);
	});

	test("works with any registered classifier, and a caller may name another one", async () => {
		let models = [
			{ provider: "acme-labs", id: "decider-2" },
			{ provider: "cloudflare-workers-ai", id: "@cf/cloudflare/clef" },
		];
		let registry = fakeRegistry(() => ({ answers: answers as any }), models);
		let decide = createDecide(registry, { model: "acme-labs/decider-2", timeoutMs: 30_000 });
		expect((await decide(request)).model).toBe("decider-2");
		expect((await decide(request, { model: "cloudflare-workers-ai/@cf/cloudflare/clef" })).model)
			.toBe("@cf/cloudflare/clef");
		expect(registry.calls.map(call => call.model)).toEqual(models);
		expect((await decide(request)).usage).toEqual({ input_tokens: 0, output_tokens: 0 });
	});

	test("an unknown model fails before any request", async () => {
		let registry = fakeRegistry(() => ({ answers: answers as any }));
		await expect(createDecide(registry, settings)(request, { model: "typesafe/jev-9" }))
			.rejects.toThrow("typesafe/jev-9 is not a classifier");
		expect(registry.calls).toHaveLength(0);
	});

	test("a provider error is one failed attempt without its response body", async () => {
		let registry = fakeRegistry(() => ({
			stopReason: "error",
			errorMessage: 'System One API error (503): {"error":"secret body"}',
		}));
		let failure = createDecide(registry, settings)(request);
		await expect(failure).rejects.toThrow("Decisions HTTP 503");
		await expect(failure).rejects.not.toThrow("secret");
		expect(registry.calls).toHaveLength(1);
		let refused = fakeRegistry(() => ({ stopReason: "error", errorMessage: "refused to answer" }));
		await expect(createDecide(refused, settings)(request)).rejects.toThrow(
			"Decisions request failed",
		);
	});

	function stalled() {
		return fakeRegistry((_, __) => new Promise(() => {}));
	}

	test("the timeout ends a stalled classifier", async () => {
		let registry = stalled();
		await expect(createDecide(registry, { ...settings, timeoutMs: 100 })(request)).rejects
			.toThrow("Decisions request timed out");
		expect(registry.calls).toHaveLength(1);
	});

	test("caller abort ends the request before the timeout", async () => {
		let controller = new AbortController();
		let pending = createDecide(stalled(), settings)(request, { signal: controller.signal });
		controller.abort();
		await expect(pending).rejects.toThrow("Decisions request aborted");
	});

	test("rejects malformed answers instead of returning partial results", async () => {
		let mutations: Array<(value: any) => void> = [
			value => delete value.flag,
			value => value.extra = { type: "bool", probability: 0.5 },
			value => value.flag = { type: "choice", choice: "save", confidence: 1, probabilities: {} },
			value => value.flag.probability = 1.2,
			value => value.flag.probability = Number.NaN,
			value => value.action.choice = "other",
			value => value.action.choice = "skip",
			value => value.action.confidence = 1.1,
			value => value.action.probabilities = { save: 1 },
			value => value.action.probabilities = { save: 0.85, skip: 0.15, other: 0 },
			value => value.action.probabilities = { save: 0.5, skip: 0.1 },
			value => value.strength.score = 2.5,
			value => value.strength.score = -0.1,
			value => value.strength.confidence = -1,
		];
		for (let mutate of mutations) {
			let value = structuredClone(answers);
			mutate(value);
			let registry = fakeRegistry(() => ({ answers: value as any }));
			await expect(createDecide(registry, settings)(request)).rejects.toThrow("invalid decision");
		}
	});

	test("rejects request bounds before asking", async () => {
		let registry = fakeRegistry(() => ({ answers: answers as any }));
		let decide = createDecide(registry, settings);
		let flag = request.questions.flag!;
		let invalid: JevRequest[] = [
			{ state: "", questions: {} },
			{ state: "x".repeat(24001), questions: { flag } },
			{
				state: "",
				questions: Object.fromEntries(
					Array.from({ length: 46 }, (_, index) => [`q${index}`, flag]),
				),
			},
			{ state: "", questions: { "invalid id": flag } },
			{ state: "", questions: { flag: { ...flag, instructions: "" } } },
			{
				state: "",
				questions: {
					action: { type: "choice", instructions: "Choose", criteria: { only: "One" } },
				},
			},
			{
				state: "",
				questions: { strength: { type: "score", instructions: "Rate", criteria: ["One"] } },
			},
		];
		for (let value of invalid) {
			await expect(decide(value)).rejects.toThrow("invalid decision request");
		}
		await expect(decide(request, { timeoutMs: 99 })).rejects.toThrow("invalid decision timeout");
		expect(registry.calls).toHaveLength(0);
	});
});

describe("openDecisions", () => {
	let config = {
		decisionsModel: "acme-labs/decider-2",
		conversationInitiativeModel: undefined,
		decisionsTimeoutMs: 30_000,
	};
	let models = [
		{ provider: "acme-labs", id: "decider-2" },
		{ provider: "typesafe", id: "jev-latest" },
	];

	test("opens the configured classifier when its provider has credentials", async () => {
		let registry = fakeRegistry(() => ({ answers: answers as any }), models);
		let decide = await openDecisions(config, registry);
		expect((await decide!(request)).model).toBe("decider-2");
		expect(await openDecisions({ ...config, decisionsModel: undefined }, registry))
			.toBeUndefined();
	});

	test("refuses an unknown model or a provider without credentials, naming the model", async () => {
		let registry = fakeRegistry(() => ({}), models, [models[1]!]);
		await expect(openDecisions({ ...config, decisionsModel: "acme-labs/decider-9" }, registry))
			.rejects.toThrow("DECISIONS_MODEL acme-labs/decider-9 is not a classifier");
		await expect(openDecisions(config, registry)).rejects.toThrow(
			"DECISIONS_MODEL acme-labs/decider-2 has no credentials. Set the acme-labs API key",
		);
		await expect(
			openDecisions({
				...config,
				decisionsModel: "typesafe/jev-latest",
				conversationInitiativeModel: "acme-labs/decider-2",
			}, registry),
		).rejects.toThrow("CONVERSATION_INITIATIVE_MODEL acme-labs/decider-2 has no credentials");
	});
});

describe("Atomic's registry", () => {
	let network = globalThis.fetch;
	let openai = process.env.OPENAI_API_KEY;
	afterEach(() => {
		globalThis.fetch = network;
		if (openai === undefined) delete process.env.OPENAI_API_KEY;
		else process.env.OPENAI_API_KEY = openai;
	});

	test("JEV_API_KEY sends TypeSafe the same System One request", async () => {
		let seen: { url: string; init: RequestInit }[] = [];
		globalThis.fetch = Object.assign(async (url: string | URL | Request, init?: RequestInit) => {
			seen.push({ url: String(url), init: init! });
			return Response.json({
				model: "jev-1.13.0",
				answers: {
					flag: { type: "noul", noul: 0.9 },
					named: { type: "noul", noul: 0.2 },
					action: {
						type: "choice",
						choice: "save",
						confidence: 0.8,
						probabilities: { save: 0.85, skip: 0.15 },
					},
					strength: {
						type: "score",
						score: 1.1,
						confidence: 0.55,
						legend: { "0": "Low", "1": "Some", "2": "High" },
						probabilities: { "0": 0.1, "1": 0.7, "2": 0.2 },
					},
				},
				usage: { input_tokens: 10, output_tokens: 2 },
			});
		}, { preconnect: network.preconnect });
		let registry = await decisionsRegistry({ JEV_API_KEY: "jev-test-key" });
		let decide = await openDecisions({
			decisionsModel: "typesafe/jev-latest",
			conversationInitiativeModel: undefined,
			decisionsTimeoutMs: 30_000,
		}, registry);
		let result = await decide!(request);
		expect(seen).toHaveLength(1);
		expect(seen[0]!.url).toBe("https://api.typesafe.ai/v1/systemone");
		expect(new Headers(seen[0]!.init.headers).get("authorization")).toBe("Bearer jev-test-key");
		expect(JSON.parse(String(seen[0]!.init.body))).toEqual({
			model: "jev-latest",
			state: request.state,
			questions: {
				...request.questions,
				flag: { ...request.questions.flag, criteria: { true: "Yes", false: "No" } },
			},
		});
		expect(result.answers.flag).toEqual({ type: "noul", noul: 0.9 });
		expect(result.usage).toEqual({ input_tokens: 10, output_tokens: 2 });
	});

	test("OPENAI_API_KEY answers through OpenAI's Decisions API", async () => {
		process.env.OPENAI_API_KEY = "openai-test-key";
		let seen: { url: string; body: any }[] = [];
		globalThis.fetch = Object.assign(async (url: string | URL | Request, init?: RequestInit) => {
			seen.push({ url: String(url), body: JSON.parse(String(init!.body)) });
			return Response.json({
				answers: [
					{ type: "predicate", name: "flag", probability: 0.92 },
					{ type: "predicate", name: "named", probability: 0.1 },
					{
						type: "choice",
						name: "action",
						choice: "save",
						probabilities: [
							{ value: "save", probability: 0.95 },
							{ value: "skip", probability: 0.05 },
						],
						confidence: 0.93,
					},
					{
						type: "score",
						name: "strength",
						score: 1.1,
						probabilities: [
							{ value: 0, label: "Low", probability: 0.1 },
							{ value: 1, label: "Some", probability: 0.7 },
							{ value: 2, label: "High", probability: 0.2 },
						],
						confidence: 0.55,
					},
				],
				usage: { input_tokens: 30 },
			});
		}, { preconnect: network.preconnect });
		let registry = await decisionsRegistry({});
		let decide = await openDecisions({
			decisionsModel: "openai-decisions/gpt-6-luna",
			conversationInitiativeModel: undefined,
			decisionsTimeoutMs: 30_000,
		}, registry);
		let result = await decide!(request);
		expect(seen[0]!.url).toBe("https://api.openai.com/v1/decisions");
		expect(seen[0]!.body).toMatchObject({
			model: "gpt-6-luna",
			input: JSON.stringify(request.state),
			questions: [
				{ type: "predicate", name: "flag" },
				{ type: "predicate", name: "named" },
				{ type: "choice", name: "action" },
				{
					type: "score",
					name: "strength",
					levels: [{ label: "Low" }, { label: "Some" }, { label: "High" }],
				},
			],
		});
		expect(result).toMatchObject({
			model: "gpt-6-luna",
			usage: { input_tokens: 30, output_tokens: 0 },
			answers: {
				flag: { type: "noul", noul: 0.92 },
				action: { type: "choice", choice: "save", probabilities: { save: 0.95, skip: 0.05 } },
				strength: { type: "score", score: 1.1, legend: { "0": "Low", "1": "Some", "2": "High" } },
			},
		});
	});

	test("refuses OpenAI's classifier at startup without an OpenAI key", async () => {
		delete process.env.OPENAI_API_KEY;
		let registry = await decisionsRegistry({});
		await expect(openDecisions({
			decisionsModel: "openai-decisions/gpt-6-luna",
			conversationInitiativeModel: undefined,
			decisionsTimeoutMs: 30_000,
		}, registry)).rejects.toThrow(
			"DECISIONS_MODEL openai-decisions/gpt-6-luna has no credentials. Set the OpenAI API key",
		);
	});
});

test.skipIf(!process.env.OPENAI_API_KEY)(
	"live: OpenAI's Decisions API answers a predicate",
	async () => {
		let decide = await openDecisions({
			decisionsModel: "openai-decisions/gpt-6-luna",
			conversationInitiativeModel: undefined,
			decisionsTimeoutMs: 30_000,
		}, await decisionsRegistry({}));
		let result = await decide!({
			state: { message: "What time does the train leave?" },
			questions: { question: { type: "noul", instructions: "Does the message ask a question?" } },
		});
		expect(result.answers.question?.type).toBe("noul");
		expect((result.answers.question as { noul: number }).noul).toBeGreaterThan(0.5);
	},
	30_000,
);
