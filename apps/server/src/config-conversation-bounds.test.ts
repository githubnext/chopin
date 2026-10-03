import { expect, test } from "bun:test";
import { describe as description } from "./config";
import { configured } from "./config-conversation.test-fixtures";

test("only the exact opt-in enables analysis and a generic transport key is insufficient", () => {
	for (let flag of [undefined, "", "off", "ON", "true", "1"]) {
		expect(configured({ CONVERSATION_PLAN: flag })).toMatchObject({
			conversationPlan: false,
			conversationPlanModel: "jev-latest",
			conversationPlanTimeoutMs: 30_000,
		});
	}
	expect(() => configured({ CONVERSATION_PLAN: "on", TYPESAFE_API_KEY: "synthetic" }))
		.toThrow("JEV_API_KEY is required when CONVERSATION_PLAN=on");
	expect(() => configured({ CONVERSATION_PLAN: "on", JEV_API_KEY: "" })).toThrow("JEV_API_KEY");
});

test("timeout bounds are validated even when conversation analysis is off", () => {
	for (let timeout of ["100", "60000", "000100"]) {
		expect(configured({ JEV_TIMEOUT_MS: timeout }).conversationPlanTimeoutMs).toBe(Number(timeout));
	}
	for (let timeout of ["99", "60001", "-100", "+100", " 100", "100 ", "1e3", "9007199254740992"]) {
		expect(() => configured({ JEV_TIMEOUT_MS: timeout })).toThrow("JEV_TIMEOUT_MS");
	}
});

test("model alias validation is opt-in and does not expose the transport credential", () => {
	let config = configured({
		CONVERSATION_PLAN: "on",
		JEV_API_KEY: "synthetic-test-key",
		JEV_MODEL: "jev.experimental-v1_2",
		JEV_TIMEOUT_MS: "100",
	});
	expect(config.conversationPlanModel).toBe("jev.experimental-v1_2");
	expect(description(config)).toContain("conversation plan: jev.experimental-v1_2");
	expect(description(config)).not.toContain("synthetic-test-key");
	expect(configured({ JEV_MODEL: "invalid alias" }).conversationPlanModel).toBe("invalid alias");
	for (let alias of ["with spaces", "with/slash", "x".repeat(101)]) {
		expect(() =>
			configured({ CONVERSATION_PLAN: "on", JEV_API_KEY: "synthetic", JEV_MODEL: alias })
		)
			.toThrow("JEV_MODEL");
	}
});
