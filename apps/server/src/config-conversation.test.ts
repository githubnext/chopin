import { describe, expect, it } from "bun:test";
import { configured } from "./config-conversation.test-fixtures";

describe("conversation configuration", () => {
	it("enables conversation analysis only by explicit opt-in, independently of Planner", () => {
		expect(configured({ JEV_API_KEY: "present" }).conversationPlan).toBe(false);
		expect(configured({ CONVERSATION_PLAN: "on", AGENT: "off", JEV_API_KEY: "present" }))
			.toMatchObject({
				agent: false,
				conversationPlan: true,
				decisionsModel: "typesafe/jev-latest",
			});
		expect(() => configured({ CONVERSATION_PLAN: "on", JEV_API_KEY: undefined })).toThrow(
			"JEV_API_KEY",
		);
		expect(
			configured({ CONVERSATION_PLAN: "on", JEV_API_KEY: "present" }).decisionsTimeoutMs,
		).toBe(30_000);
		expect(
			configured({
				CONVERSATION_PLAN: "on",
				JEV_API_KEY: "present",
				DECISIONS_TIMEOUT_MS: "45000",
			}).decisionsTimeoutMs,
		).toBe(45_000);
	});
});
