import { expect, spyOn, test } from "bun:test";
import {
	parseResearchBriefInput,
	researchBriefDefinition,
	type ResearchBriefInput,
	sourceId,
} from "./research-brief";
import type { JobExecution } from "./registry";
import { researchBriefAgent } from "../harness/agents";
import * as Worker from "./worker-session";

function input(): ResearchBriefInput {
	return {
		offerId: "offer",
		generation: 1,
		mode: "automatic",
		previousBrief: "",
		parentBrief: "",
		context: { messages: [], decisions: [] },
		sources: [{
			messageId: "m",
			author: { kind: "member", handle: "ana" },
			quote: "Investigate Jev alternatives.",
			start: 0,
			end: "Investigate Jev alternatives.".length,
		}],
	};
}

test("brief worker accepts only bounded source-grounded output", async () => {
	let material = input();
	let definition = researchBriefDefinition({
		config: { agent: true, model: "fixture" },
		engine: async () => ({
			brief: "Compare Jev alternatives.",
			sourceIds: [sourceId(material.sources[0]!)],
			model: "fixture",
		}),
	});
	let result = await definition.execute({ input: material } as JobExecution<ResearchBriefInput>);
	expect(result).toMatchObject({
		offerId: "offer",
		generation: 1,
		brief: "Compare Jev alternatives.",
	});
	expect(definition.credential).toBe("active-planner");
	expect(definition.origins).toEqual(["scheduler"]);
	let invalid = researchBriefDefinition({
		config: { agent: true, model: "fixture" },
		engine: async () => ({
			brief: "Invented scope",
			sourceIds: ["not-provided"],
			model: "fixture",
		}),
	});
	await expect(invalid.execute({ input: material } as JobExecution<ResearchBriefInput>)).rejects
		.toThrow("brief-source-invalid");
});

test("brief input rejects extra capabilities and oversized context", () => {
	expect(parseResearchBriefInput(input())).toEqual(input());
	expect(() => parseResearchBriefInput({ ...input(), token: "secret" })).toThrow();
	expect(() =>
		parseResearchBriefInput({
			...input(),
			context: {
				messages: [{
					id: "large",
					author: { kind: "member", handle: "ana" },
					text: "x".repeat(25000),
				}],
				decisions: [],
			},
		})
	).toThrow();
});

test("the default brief engine opens a worker within Copilot's session credit contract", async () => {
	let material = input();
	let creditLimit = 0;
	let closed: string[] = [];
	let session = {
		destroy: async () => {
			closed.push("session");
		},
	};
	let openWorker = Worker.openWorkerSession;
	let opener = spyOn(Worker, "openWorkerSession").mockImplementation((agent, options) => {
		creditLimit = options.maxAiCredits;
		return openWorker(agent, {
			...options,
			openSandbox: async () =>
				({
					destroy: async () => {
						closed.push("sandbox");
					},
				}) as unknown as Worker.WorkerSandbox,
		});
	});
	let create = spyOn(researchBriefAgent, "createSession").mockImplementation(async () => {
		if (creditLimit < 30) throw new Error("Minimum session limit is 30 AI credits.");
		return session as never;
	});
	let generate = spyOn(researchBriefAgent, "generate").mockImplementation(async () =>
		({
			output: { brief: "Compare Jev alternatives.", sourceIds: [sourceId(material.sources[0]!)] },
		}) as never
	);
	try {
		let definition = researchBriefDefinition({ config: { agent: true, model: "fixture" } });
		let result = await definition.execute({
			input: material,
			signal: new AbortController().signal,
			deadline: new Date(Date.now() + 60_000),
			credential: { kind: "active-planner", token: "fixture-only", authorize: async () => true },
		} as JobExecution<ResearchBriefInput>);
		expect(result.brief).toBe("Compare Jev alternatives.");
		expect(creditLimit).toBe(definition.limits.maxAiCredits);
		expect(create).toHaveBeenCalledTimes(1);
		expect(generate).toHaveBeenCalledTimes(1);
		expect(closed).toEqual(["session", "sandbox"]);
	} finally {
		opener.mockRestore();
		create.mockRestore();
		generate.mockRestore();
	}
});
