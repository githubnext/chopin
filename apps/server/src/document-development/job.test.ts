import { expect, test } from "bun:test";
import type { JobExecution } from "../jobs/registry";
import { documentDevelopmentDefinition } from "./job";
import type { DocumentDevelopmentInput } from "./schema";

function input(): DocumentDevelopmentInput {
	return {
		messageId: "m",
		revision: 2,
		decisionHash: `sha256:${"0".repeat(64)}`,
		capacity: { additions: 48, characters: 12000 },
		source: "",
		messages: [{ id: "m", author: "ana", text: "Explore keeping the editor open during saves." }],
		passages: [],
		decisions: [],
	};
}

test("the job stamps host identity and captures it before running the engine", async () => {
	let material = input();
	let definition = documentDevelopmentDefinition({
		config: { agent: true, model: "fixture" },
		engine: async execution => {
			execution.input.messageId = "tampered";
			execution.input.revision = 99;
			execution.input.decisionHash = `sha256:${"f".repeat(64)}`;
			return {
				changes: [{
					id: null,
					markdown: "Proposal: keep the editor open during saves.",
					sourceIds: ["m"],
				}],
				removals: [],
				model: "fixture",
				messageId: "untrusted",
				revision: 999,
				decisionHash: "untrusted",
			};
		},
	});
	let result = await definition.execute(
		{ input: material } as JobExecution<DocumentDevelopmentInput>,
	);
	expect(result).toMatchObject({
		messageId: "m",
		revision: 2,
		decisionHash: material.decisionHash,
	});
	expect(material).toEqual(input());
	expect(definition.credential).toBe("active-planner");
	expect(definition.origins).toEqual(["scheduler"]);
	expect(definition.limits).toEqual({
		timeoutMs: 60000,
		maxAttempts: 1,
		maxAiCredits: 30,
		maxInputBytes: 128 * 1024,
		maxArtifactBytes: 16 * 1024,
	});
});

test("the job accepts unchanged output and rejects invented provenance without echoing prose", async () => {
	for (let sourceIds of [[], ["unknown"], ["m", "m"]]) {
		let definition = documentDevelopmentDefinition({
			config: { agent: true, model: "fixture" },
			engine: async () => ({
				changes: [{ id: null, markdown: "private text", sourceIds }],
				removals: [],
				model: "fixture",
			}),
		});
		await expect(definition.execute({ input: input() } as JobExecution<DocumentDevelopmentInput>))
			.rejects.toThrow("document-development-output-invalid");
	}
	let definition = documentDevelopmentDefinition({
		config: { agent: true, model: "fixture" },
		engine: async () => ({ changes: [], removals: [], model: "fixture" }),
	});
	expect(await definition.execute({ input: input() } as JobExecution<DocumentDevelopmentInput>))
		.toEqual({
			messageId: "m",
			revision: 2,
			decisionHash: input().decisionHash,
			changes: [],
			removals: [],
			model: "fixture",
		});
});

test("an injected engine cannot add undeclared artifact fields", async () => {
	let definition = documentDevelopmentDefinition({
		config: { agent: true, model: "fixture" },
		engine: async () => ({ changes: [], removals: [], model: "fixture", token: "unexpected" }),
	});
	await expect(definition.execute({ input: input() } as JobExecution<DocumentDevelopmentInput>))
		.rejects.toThrow("document-development-output-invalid");
});
