import { createJustBashNetworkSandboxSession } from "@ai-sdk/sandbox-just-bash";
import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { modelLevels, refusedChoice } from "@chopin/protocol/model-choice";

import { atomicCatalog, createAtomicAdapter } from "./adapter";
import { registerFullPlanner } from "./full";
import { startStubModelServer } from "./model-stub";

import type { PlannerTurn } from "../turn-level";
import type { FullPlanner } from "./full";

let stub = startStubModelServer(() => ({ kind: "text", text: "Done." }));
afterAll(stub.stop);

const COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const MODELS = [
	{
		id: "plain",
		name: "Plain",
		reasoning: false,
		input: ["text" as const],
		cost: COST,
		contextWindow: 128_000,
		maxTokens: 4_096,
	},
	{
		id: "deep",
		name: "Deep",
		reasoning: true,
		input: ["text" as const],
		cost: COST,
		contextWindow: 1_000_000,
		maxTokens: 4_096,
	},
	{
		id: "other",
		name: "Other",
		reasoning: true,
		thinkingLevelMap: { high: null },
		input: ["text" as const],
		cost: COST,
		contextWindow: 200_000,
		maxTokens: 4_096,
	},
];

function adapter(auth: "auto" | "ai-gateway" = "ai-gateway") {
	return createAtomicAdapter({
		auth,
		model: "stub/plain",
		providers: {
			stub: { baseUrl: stub.baseUrl, apiKey: "stub", api: "openai-completions", models: MODELS },
		},
	});
}

describe("the catalog Atomic offers for a document's Planner", () => {
	it("lists the runtime's models by provider with their thinking levels and context size", async () => {
		let catalog = await adapter().catalog("stub/plain");
		let deep = catalog.models.find(model => model.id === "stub/deep");
		expect(deep).toMatchObject({
			name: "Deep",
			provider: { id: "stub" },
			description: "1M token context",
		});
		// Atomic's own levels for a reasoning model that maps none of them away.
		expect(deep!.thinkingLevels).toEqual(["off", "minimal", "low", "medium", "high"]);
		let plain = catalog.models.find(model => model.id === "stub/plain");
		expect(plain).toMatchObject({ name: "Plain", description: "128K token context" });
		// What the model reads is Atomic's own word for it, so a composer sends only images it can.
		expect(plain!.inputTypes).toEqual(["text"]);
		expect("thinkingLevels" in plain!).toBe(false);
		expect(catalog.default).toEqual({ model: "stub/plain" });
	});

	it("offers nothing the deployment's HARNESS_AUTH would refuse to run", async () => {
		let runtime = {
			getAvailable: async () => [
				{
					provider: "vercel-ai-gateway",
					id: "a/b",
					name: "Gateway",
					reasoning: false,
					contextWindow: 8_000,
				},
				{
					provider: "anthropic",
					id: "c",
					name: "Host login",
					reasoning: false,
					contextWindow: 8_000,
				},
				{ provider: "stub", id: "d", name: "Registered", reasoning: false, contextWindow: 8_000 },
			],
			getModel: () => undefined,
			getProvider: () => undefined,
		};
		let gateway = await atomicCatalog(runtime as never, {
			auth: "ai-gateway",
			providers: { stub: {} as never },
		}, undefined);
		expect(gateway.models.map(model => model.id).toSorted()).toEqual([
			"stub/d",
			"vercel-ai-gateway/a/b",
		]);
		let host = await atomicCatalog(runtime as never, { auth: "auto" }, undefined);
		expect(host.models).toHaveLength(3);
		expect(host.default).toBeUndefined();
	});

	it("lists every model the runtime offers, however many", async () => {
		let many = Array.from({ length: 710 }, (_, index) => ({
			...MODELS[0]!,
			id: `m${index}`,
			name: `Model ${index}`,
		}));
		let harness = createAtomicAdapter({
			auth: "ai-gateway",
			model: "stub/plain",
			providers: {
				stub: {
					baseUrl: stub.baseUrl,
					apiKey: "stub",
					api: "openai-completions",
					models: [...MODELS, ...many],
				},
			},
		});
		let catalog = await harness.catalog("stub/plain");
		expect(catalog.models).toHaveLength(MODELS.length + many.length);
		expect(catalog.models.at(-1)!.id).toStartWith("stub/");
		expect(catalog.models.some(model => model.id === "stub/m709")).toBe(true);
		expect(catalog.default).toEqual({ model: "stub/plain" });
		await harness.shutdown();
	});

	it("lists the runtime's models in the order it reports them, each provider where it first appears", async () => {
		let plain = { reasoning: false, contextWindow: 8_000 };
		let runtime = {
			getAvailable: async () => [
				{ ...plain, provider: "zeta", id: "one", name: "One" },
				{ ...plain, provider: "alpha", id: "two", name: "Two" },
				{ ...plain, provider: "zeta", id: "three", name: "Three" },
			],
			getModel: () => undefined,
			getProvider: (id: string) => ({ name: id === "zeta" ? "Zeta" : "Alpha" }),
		};
		let catalog = await atomicCatalog(runtime as never, { auth: "auto" }, undefined);
		// Not sorted by provider name: the runtime's own order stands, and the picker groups by it.
		expect(catalog.models.map(entry => entry.id)).toEqual(["zeta/one", "alpha/two", "zeta/three"]);
	});

	it("lists a model the runtime reports twice once for each entry, as the runtime resolves it", async () => {
		let duplicates = [
			{ ...MODELS[0]!, id: "twin", name: "First twin" },
			{ ...MODELS[1]!, id: "twin", name: "Second twin" },
			{ ...MODELS[0]!, id: "after", name: "After" },
		];
		let harness = createAtomicAdapter({
			auth: "ai-gateway",
			model: "stub/plain",
			providers: {
				stub: {
					baseUrl: stub.baseUrl,
					apiKey: "stub",
					api: "openai-completions",
					models: [MODELS[0]!, ...duplicates],
				},
			},
		});
		try {
			let catalog = await harness.catalog("stub/plain");
			let twins = catalog.models.filter(entry => entry.id === "stub/twin");
			// Each entry stays, in the order reported, with the levels of its own model.
			expect(twins.map(entry => entry.name)).toEqual(["First twin", "Second twin"]);
			expect("thinkingLevels" in twins[0]!).toBe(false);
			expect(twins[1]!.thinkingLevels).toEqual(["off", "minimal", "low", "medium", "high"]);
			expect(catalog.models.map(entry => entry.id)).toEqual([
				"stub/plain",
				"stub/twin",
				"stub/twin",
				"stub/after",
			]);
			// A choice of that id is the first entry's, as the runtime runs it: no level is offered.
			expect(modelLevels(catalog, "stub/twin")).toEqual([]);
			expect(refusedChoice(catalog, { model: "stub/twin", thinkingLevel: "high" })).toBeString();
		} finally {
			await harness.shutdown();
		}
	});

	it("keeps the deployment's default in the catalog when it is not among the available models", async () => {
		let catalog = await adapter().catalog("stub/deep");
		expect(catalog.models.some(model => model.id === "stub/deep")).toBe(true);
		expect(catalog.default).toEqual({ model: "stub/deep" });
		// A default Atomic cannot run is not offered as one.
		expect((await adapter().catalog("stub/missing")).default).toBeUndefined();
	});
});

describe("a chosen model and thinking level reach the Atomic session", () => {
	/**
	 * Runs `steps` as the turns of one full Planner session and reads what each asked the provider
	 * for. The operator's Atomic settings are the ones given, never the developer's own.
	 */
	async function turns(
		steps: { prompt: string; model?: string; thinkingLevel?: string }[],
		operator: object = {},
	) {
		let root = await mkdtemp(join(tmpdir(), "chopin-atomic-choice-"));
		let agentDir = join(root, "agent");
		await mkdir(agentDir);
		await writeFile(join(agentDir, "settings.json"), JSON.stringify(operator));
		let previous = process.env.ATOMIC_CODING_AGENT_DIR;
		process.env.ATOMIC_CODING_AGENT_DIR = agentDir;
		let harness = adapter();
		let sandbox = await createJustBashNetworkSandboxSession();
		let sessionId = crypto.randomUUID();
		let planner: FullPlanner = {
			cwd: root,
			humanInput: {
				confirm: async () => false,
				select: async () => undefined,
				input: async () => undefined,
				editor: async () => undefined,
				questionnaire: async () => ({ answers: [], cancelled: true }),
			},
		};
		let release = registerFullPlanner(sessionId, planner);
		let session = await harness.doStart({
			sessionId,
			sandboxSession: sandbox as never,
			sessionWorkDir: root,
		});
		stub.requests.length = 0;
		try {
			for (let step of steps) {
				let control = await session.doPromptTurn({
					prompt: step.prompt,
					skills: [],
					tools: [],
					...(step.model ? { model: step.model } : {}),
					...(step.thinkingLevel ? { thinkingLevel: step.thinkingLevel } : {}),
					emit: () => {},
				} as PlannerTurn);
				await control.done;
			}
			return stub.requests.map(request => [request.prompt, request.model, request.reasoningEffort]);
		} finally {
			await session.doDestroy();
			release();
			await harness.shutdown();
			if (previous === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
			else process.env.ATOMIC_CODING_AGENT_DIR = previous;
			await rm(root, { recursive: true, force: true });
		}
	}

	it("runs the deployment's model and the session's own level until somebody chooses", async () => {
		let seen = await turns([{ prompt: "first" }]);
		expect(seen[0]![1]).toBe("plain");
		expect(seen[0]![2]).toBeUndefined();
	});

	it("runs the chosen model and level from the next turn, then goes back to the default", async () => {
		let seen = await turns([
			{ prompt: "first" },
			{ prompt: "second", model: "stub/deep", thinkingLevel: "high" },
			{ prompt: "third", model: "stub/deep" },
			{ prompt: "fourth" },
		]);
		expect(seen.map(row => [row[0], row[1]])).toEqual([
			["first", "plain"],
			["second", "deep"],
			["third", "deep"],
			["fourth", "plain"],
		]);
		expect(seen[1]![2]).toBe("high");
		// Without a chosen level the model runs its own: the level Atomic gives a reasoning model
		// that nobody has set (`medium`), not the `off` of the plain model the session began on.
		expect(seen[2]![2]).toBe("medium");
		// A model that does not reason has none to send.
		expect(seen[3]![2]).toBeUndefined();
	});

	it("runs a model's own level the same whether or not a person chose one before it", async () => {
		// Where a session has been must not change what a model runs when nobody chooses: Atomic's
		// own level for it, the operator's saved one for that model or their default, else `medium`.
		let last = async (steps: Parameters<typeof turns>[0], operator?: object) =>
			(await turns(steps, operator)).at(-1)![2];
		let chosen = { prompt: "chosen", model: "stub/deep", thinkingLevel: "high" };
		let operators: Array<[object, Record<string, string>]> = [
			[{}, { "stub/deep": "medium", "stub/other": "medium" }],
			[
				{ defaultThinkingLevel: "low", modelThinkingLevels: { "stub/other": "minimal" } },
				{ "stub/deep": "low", "stub/other": "minimal" },
			],
		];
		for (let [operator, own] of operators) {
			for (let model of ["stub/deep", "stub/other"]) {
				let next = { prompt: "next", model };
				let straight = await last([{ prompt: "first" }, next], operator);
				expect(straight).toBe(own[model]!);
				expect(await last([{ prompt: "first" }, chosen, next], operator)).toBe(straight);
			}
		}
	}, 30_000);
});
