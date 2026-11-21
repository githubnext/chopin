import { afterEach, describe, expect, it } from "bun:test";

import { ACCOUNT_MODELS_FRESH_MS, accountCatalog, accountModels } from "./account-models";

import type { AccountModelSources } from "./account-models";
import type { HeldCatalog } from "./model-catalog";

const NOW = Date.parse("2027-03-01T12:00:00.000Z");
const COPILOT = "https://api.githubcopilot.com";

/** A models.dev catalog model, as the public catalog describes one. */
function described(id: string, name: string, efforts?: string[]) {
	return {
		id,
		name,
		attachment: true,
		reasoning: efforts !== undefined,
		...(efforts ? { reasoning_options: [{ type: "effort", values: efforts }] } : {}),
		tool_call: true,
		modalities: { input: ["text", "image"], output: ["text"] },
		limit: { context: 200_000, output: 32_000 },
		cost: { input: 1, output: 2 },
	};
}

/** The public catalog as Chopin holds it, with one Copilot and one OpenAI model of its own. */
function catalog(): HeldCatalog {
	let body = {
		"github-copilot": {
			id: "github-copilot",
			name: "GitHub Copilot",
			api: COPILOT,
			npm: "@ai-sdk/openai-compatible",
			models: {
				"chopin-large": {
					...described("chopin-large", "Chopin Large", ["low", "medium", "high"]),
					provider: { npm: "@ai-sdk/openai" },
				},
				"chopin-small": {
					...described("chopin-small", "Chopin Small"),
					provider: { npm: "@ai-sdk/openai" },
				},
			},
		},
		openai: {
			id: "openai",
			name: "OpenAI",
			npm: "@ai-sdk/openai",
			models: { "chopin-keyed": described("chopin-keyed", "Chopin Keyed", ["low", "high"]) },
		},
	};
	return {
		body: new TextEncoder().encode(JSON.stringify(body)),
		headers: new Headers({ "content-type": "application/json" }),
		fetchedAt: NOW,
	};
}

/** One entry of Copilot's `GET /models`, as the account's list gives it. */
function listed(id: string, name: string, picker: boolean, efforts: string[] = []) {
	return {
		id,
		name,
		model_picker_enabled: picker,
		policy: { state: "enabled" },
		supported_endpoints: ["/chat/completions"],
		capabilities: {
			type: "chat",
			family: id,
			limits: { max_context_window_tokens: 64_000, max_output_tokens: 8_000 },
			supports: { tool_calls: true, ...(efforts.length ? { reasoning_effort: efforts } : {}) },
		},
	};
}

/** Copilot's list for the account: Large in its picker, Small hidden, and one model of its own. */
const LIST = {
	data: [
		listed("chopin-large", "Large (account's name)", true),
		listed("chopin-small", "Small", false),
		listed("chopin-own", "Chopin Own", true, ["low", "high"]),
	],
};

function copilot(list: unknown = LIST): AccountModelSources {
	return { providers: ["github-copilot"], copilot: { list, baseUrl: COPILOT } };
}

let environment = { ...process.env };
afterEach(() => {
	for (let name of Object.keys(process.env)) if (!(name in environment)) delete process.env[name];
	Object.assign(process.env, environment);
});

describe("a person's models from their AI accounts", () => {
	it("lists the Copilot models the account's own list enables, by the catalog's names, with the ones it adds", async () => {
		let listed = await accountCatalog({ sources: copilot(), catalog: catalog(), now: NOW });
		expect(listed).toEqual({
			models: [
				{
					id: "github-copilot/chopin-large",
					name: "Chopin Large",
					provider: { id: "github-copilot", name: "GitHub Copilot" },
					description: "200K token context",
					thinkingLevels: ["low", "medium", "high"],
					inputTypes: ["text", "image"],
				},
				{
					id: "github-copilot/chopin-own",
					name: "Chopin Own",
					provider: { id: "github-copilot", name: "GitHub Copilot" },
					description: "64K token context",
					thinkingLevels: ["low", "high"],
					inputTypes: ["text"],
				},
			],
		});
	});

	it("leaves Copilot out where its list couldn't be read, as a Planner does until it has it", async () => {
		for (let sources of [{ providers: ["github-copilot"] } as const, copilot({ models: [] })]) {
			expect(await accountCatalog({ sources, catalog: catalog(), now: NOW })).toBeUndefined();
		}
	});

	it("lists a key's provider as Atomic's own providers for it, and nothing for a key in Chopin's own environment", async () => {
		process.env.ANTHROPIC_API_KEY = "sk-ant-chopin-process";
		process.env.COPILOT_GITHUB_TOKEN = "ghu_chopin_process";
		let listed = await accountCatalog({
			sources: { providers: ["openai"] },
			catalog: catalog(),
			now: NOW,
		});
		let ids = listed!.models.map(model => model.id);
		expect(ids).toContain("openai/chopin-keyed");
		expect(new Set(listed!.models.map(model => model.provider!.id))).toEqual(
			new Set(["openai", "openai-api"]),
		);
		expect(listed!.models.find(model => model.id === "openai/chopin-keyed")).toMatchObject({
			name: "Chopin Keyed",
			thinkingLevels: ["low", "high"],
		});
	});

	it("lists the models Copilot's list adds when the catalog can't be had", async () => {
		let listed = await accountCatalog({ sources: copilot(), now: NOW });
		expect(listed!.models.map(model => model.id)).toContain("github-copilot/chopin-own");
		expect(listed!.models.map(model => model.id)).not.toContain("github-copilot/chopin-small");
	});
});

describe("the list held for each person", () => {
	function held(options: { sources?: (userId: string) => Promise<AccountModelSources> } = {}) {
		let now = NOW;
		let asked: string[] = [];
		let changed: string[] = [];
		let models = accountModels({
			sources: options.sources ?? (async userId => {
				asked.push(userId);
				return copilot();
			}),
			catalog: async () => catalog(),
			changed: userId => changed.push(userId),
			clock: () => now,
		});
		return {
			models,
			asked,
			changed,
			advance(ms: number) {
				now += ms;
			},
		};
	}

	it("is computed once and served as it is while it is fresh", async () => {
		let world = held();
		let first = await world.models.read("U_mona", 5_000);
		expect(first?.models.map(model => model.id)).toEqual([
			"github-copilot/chopin-large",
			"github-copilot/chopin-own",
		]);
		expect(await world.models.read("U_mona")).toBe(first);
		expect(world.asked).toEqual(["U_mona"]);
	});

	it("is served as it is once it is no longer fresh, and computed again behind it", async () => {
		let world = held();
		let first = await world.models.read("U_mona", 5_000);
		world.advance(ACCOUNT_MODELS_FRESH_MS);
		expect(await world.models.read("U_mona")).toBe(first);
		expect(world.asked).toEqual(["U_mona", "U_mona"]);
		// The same list again tells nobody.
		await Bun.sleep(0);
		expect(world.changed).toEqual([]);
	});

	it("is dropped when the person's accounts change, and whoever shows it hears so", async () => {
		let world = held();
		await world.models.read("U_mona", 5_000);
		world.models.forget("U_mona");
		expect(world.changed).toEqual(["U_mona"]);
		expect(await world.models.read("U_mona")).toBeUndefined();
		expect((await world.models.read("U_mona", 5_000))?.models).toHaveLength(2);
		expect(world.asked).toEqual(["U_mona", "U_mona"]);
	});

	it("is nobody else's, and tells whose list changed once one computed differs", async () => {
		let lists = new Map<string, unknown>([["U_mona", LIST], ["U_hubot", { data: [LIST.data[2]] }]]);
		let world = held({ sources: async userId => copilot(lists.get(userId)) });
		expect((await world.models.read("U_hubot", 5_000))?.models.map(model => model.id)).toEqual([
			"github-copilot/chopin-own",
		]);
		expect((await world.models.read("U_mona", 5_000))?.models).toHaveLength(2);
		lists.set("U_hubot", LIST);
		world.advance(ACCOUNT_MODELS_FRESH_MS);
		world.models.warm("U_hubot");
		for (let wait = 0; wait < 200 && !world.changed.length; wait++) await Bun.sleep(5);
		expect(world.changed).toEqual(["U_hubot"]);
		expect((await world.models.read("U_hubot"))?.models).toHaveLength(2);
	});

	it("tells whose list is ready once a reader stopped waiting for it", async () => {
		let release = Promise.withResolvers<void>();
		let world = held({
			sources: async () => {
				await release.promise;
				return copilot();
			},
		});
		expect(await world.models.read("U_mona", 5)).toBeUndefined();
		expect(world.changed).toEqual([]);
		release.resolve();
		for (let wait = 0; wait < 200 && !world.changed.length; wait++) await Bun.sleep(5);
		expect(world.changed).toEqual(["U_mona"]);
		expect((await world.models.read("U_mona"))?.models).toHaveLength(2);
	});

	it("tells a reader that stopped waiting once the person's accounts change during the first computation", async () => {
		let release = Promise.withResolvers<void>();
		let calls = 0;
		let world = held({
			sources: async () => {
				if (++calls === 1) await release.promise;
				return copilot();
			},
		});
		expect(await world.models.read("U_mona", 0)).toBeUndefined();
		world.models.forget("U_mona");
		release.resolve();
		await Bun.sleep(5);
		expect(world.changed).toEqual(["U_mona"]);
		expect((await world.models.read("U_mona", 5_000))?.models).toHaveLength(2);
	});

	it("is none, and kept as none, where the person can use nothing Chopin can list", async () => {
		let world = held({ sources: async () => ({ providers: [] }) });
		expect(await world.models.read("U_mona", 5_000)).toBeUndefined();
	});
});
