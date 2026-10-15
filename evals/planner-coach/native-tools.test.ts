import { expect, test } from "bun:test";
import { createCopilotSdk } from "../../apps/server/src/harness/copilot-sdk/adapter";
import { runScenario } from "./runner";
import { nativeCopilot } from "./test-fixtures";

test.each(["off", "fixture-prose"] as const)(
	"native Copilot tool declarations retain descriptions and types (%s)",
	async visual => {
		let native = nativeCopilot();
		let adapter = createCopilotSdk({
			credentials: () => "offline-token",
			connect: () => native.source,
		});
		try {
			let result = await runScenario({
				id: "native-declarations",
				title: "Native tool metadata",
				source: "# Test\n",
				turns: [{ speaker: "Alex", text: "Inspect the current document." }],
				expectations: [],
				maxQuestions: 0,
				requiresEvidence: false,
			}, {
				harness: adapter,
				token: "offline-token",
				instructions: "Use only the offered tools.",
				model: "offline-model",
				visual,
				limits: { maxTools: 1, turnTimeoutMs: 2_000, questionWaitMs: 100 },
			});
			expect(result.failures).toEqual([]);
			expect(result.turns[0].status).toBe("complete");
			expect(native.prompts).toEqual([result.turns[0].prompt]);
			expect(native.configurations).toHaveLength(1);
			let config = native.configurations[0];
			let tools = config.tools ?? [];
			expect(tools.map(tool => tool.name).sort()).toEqual([...result.activeTools].sort());
			expect(
				tools.filter(tool => typeof tool.description !== "string" || !tool.description.trim())
					.map(tool => tool.name),
			).toEqual([]);
			for (let tool of tools) {
				expect(typeof tool.name).toBe("string");
				expect(tool.name.length).toBeGreaterThan(0);
				expect(typeof tool.handler).toBe("function");
				expect(tool.parameters).toMatchObject({ type: "object" });
				expect(tool.skipPermission).toBe(true);
				expect(tool.defer).toBe("never");
			}
			expect(config.model).toBe("offline-model");
			expect(config.systemMessage).toMatchObject({ content: "Use only the offered tools." });
			expect(config.availableTools).toEqual(tools.map(tool => `custom:${tool.name}`));
		} finally {
			await adapter.shutdown();
		}
	},
);
