import { describe, expect, it } from "bun:test";
import { configured } from "./config-conversation.test-fixtures";

describe("conversation configuration", () => {
	it("enables conversation analysis only by explicit opt-in, independently of Planner", () => {
		expect(configured({ JEV_API_KEY: "present" }).conversationPlan).toBe(false);
		expect(configured({ CONVERSATION_PLAN: "on", AGENT: "off", JEV_API_KEY: "present" }))
			.toMatchObject({ agent: false, conversationPlan: true, conversationPlanModel: "jev-latest" });
		expect(() => configured({ CONVERSATION_PLAN: "on" })).toThrow("JEV_API_KEY");
		expect(() =>
			configured({ CONVERSATION_PLAN: "on", JEV_API_KEY: "present", JEV_MODEL: "bad name" })
		)
			.toThrow("JEV_MODEL");
		expect(
			configured({ CONVERSATION_PLAN: "on", JEV_API_KEY: "present" })
				.conversationPlanTimeoutMs,
		).toBe(30_000);
		expect(
			configured({ CONVERSATION_PLAN: "on", JEV_API_KEY: "present", JEV_TIMEOUT_MS: "45000" })
				.conversationPlanTimeoutMs,
		).toBe(45_000);
		for (let timeout of ["0", "99", "60001", "30s", "", "1.5"]) {
			expect(() =>
				configured({
					CONVERSATION_PLAN: "on",
					JEV_API_KEY: "present",
					JEV_TIMEOUT_MS: timeout,
				})
			).toThrow("JEV_TIMEOUT_MS");
		}
	});
});
