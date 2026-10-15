import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { describe as description } from "./config";
import { configured } from "./config-conversation.test-fixtures";

let none = { JEV_API_KEY: undefined, TYPESAFE_API_KEY: undefined, OPENAI_API_KEY: undefined };

test("an unset DECISIONS_MODEL follows whichever provider key is present", () => {
	expect(configured({ ...none, JEV_API_KEY: "jev" }).decisionsModel).toBe("typesafe/jev-latest");
	expect(configured({ ...none, TYPESAFE_API_KEY: "jev" }).decisionsModel)
		.toBe("typesafe/jev-latest");
	expect(configured({ ...none, OPENAI_API_KEY: "openai" }).decisionsModel)
		.toBe("openai-decisions/gpt-6-luna");
	expect(configured({ ...none, JEV_API_KEY: "jev", OPENAI_API_KEY: "openai" }).decisionsModel)
		.toBe("typesafe/jev-latest");
	expect(configured({ ...none, AGENT: "off" }).decisionsModel).toBeUndefined();
});

test("DECISIONS_MODEL names any classifier exactly", () => {
	for (
		let model of [
			"openai-decisions/gpt-6-luna",
			"cloudflare-workers-ai/@cf/cloudflare/clef",
			"acme-labs/decider-2",
		]
	) {
		expect(configured({ ...none, DECISIONS_MODEL: model }).decisionsModel).toBe(model);
	}
	expect(
		configured({ ...none, JEV_API_KEY: "jev", DECISIONS_MODEL: "openai-decisions/gpt-6-luna" }),
	)
		.toMatchObject({ decisionsModel: "openai-decisions/gpt-6-luna" });
	for (let model of ["gpt-6-luna", "/gpt-6-luna", "openai-decisions/", "a b/c", "openai/x y"]) {
		expect(() => configured({ DECISIONS_MODEL: model })).toThrow("DECISIONS_MODEL");
	}
});

test("the Planner and decision features need a decisions model, and the error names both keys", () => {
	for (
		let [overrides, reason] of [
			[{}, "AGENT is enabled"],
			[{ AGENT: "off", CONVERSATION_PLAN: "on" }, "CONVERSATION_PLAN=on"],
			[{ PLANNER_VISUALS: "on" }, "PLANNER_VISUALS=on"],
		] as const
	) {
		expect(() => configured({ ...none, ...overrides })).toThrow(
			`A decisions model is required when ${reason}. Set OPENAI_API_KEY for OpenAI's `
				+ "Decisions API, JEV_API_KEY for TypeSafe's Jev, or DECISIONS_MODEL",
		);
	}
	expect(configured({ ...none, OPENAI_API_KEY: "openai", CONVERSATION_PLAN: "on" }))
		.toMatchObject({ agent: true, conversationPlan: true });
});

test("the turn-taking judge uses the decisions model unless pinned to another classifier", () => {
	expect(configured().conversationInitiativeModel).toBeUndefined();
	expect(configured({ CONVERSATION_INITIATIVE_MODEL: "typesafe/jev-latest" }))
		.toMatchObject({ conversationInitiativeModel: "typesafe/jev-latest" });
	expect(() => configured({ CONVERSATION_INITIATIVE_MODEL: "jev-1.13.0" }))
		.toThrow("CONVERSATION_INITIATIVE_MODEL");
});

test("DECISIONS_TIMEOUT_MS bounds every request", () => {
	expect(configured().decisionsTimeoutMs).toBe(30_000);
	expect(configured({ DECISIONS_TIMEOUT_MS: "45000" }).decisionsTimeoutMs).toBe(45_000);
	expect(configured({ JEV_TIMEOUT_MS: "45000" }).decisionsTimeoutMs).toBe(30_000);
	for (let timeout of ["0", "99", "60001", "30s", "", "1.5", " 100", "1e3"]) {
		expect(() => configured({ DECISIONS_TIMEOUT_MS: timeout })).toThrow("DECISIONS_TIMEOUT_MS");
	}
});

test("the startup summary names the model and never a key", () => {
	let config = configured({ CONVERSATION_PLAN: "on", JEV_API_KEY: "synthetic-test-key" });
	expect(description(config)).toContain("conversation plan: typesafe/jev-latest");
	expect(description(config)).not.toContain("synthetic-test-key");
});

test(".env.example lists every decisions setting the server reads", () => {
	let example = readFileSync(new URL("../../../.env.example", import.meta.url), "utf8");
	let source = readFileSync(new URL("./config.ts", import.meta.url), "utf8");
	let settings = [
		"DECISIONS_MODEL",
		"DECISIONS_TIMEOUT_MS",
		"CONVERSATION_INITIATIVE_MODEL",
		"JEV_API_KEY",
		"OPENAI_API_KEY",
	];
	for (let setting of settings) {
		expect(source).toContain(`process.env.${setting}`);
		expect(example).toMatch(new RegExp(`^${setting}=`, "m"));
	}
	expect(example).not.toMatch(/^JEV_(MODEL|TIMEOUT_MS)=/m);
});
