import { expect, test } from "bun:test";
import { configured } from "./config-conversation.test-fixtures";

test("automatic participation uses the enabled Planner without an opt-in", () => {
	expect(configured({ JEV_API_KEY: "present" })).toMatchObject({
		agent: true,
		conversationPlan: false,
		conversationInitiativeSilenceMs: 15_000,
		conversationInitiativeModel: undefined,
	});
	expect(() => configured({ JEV_API_KEY: undefined }))
		.toThrow("A decisions model is required when AGENT is enabled");
	expect(configured({ AGENT: "off", JEV_API_KEY: undefined }).agent).toBe(false);
});

test("automatic participation pacing and model settings are bounded", () => {
	for (let value of ["", "0", "999", "60001", "15s", "1500.5"]) {
		expect(() => configured({ CONVERSATION_INITIATIVE_SILENCE_MS: value }))
			.toThrow("CONVERSATION_INITIATIVE_SILENCE_MS");
	}
	expect(configured({ CONVERSATION_INITIATIVE_SILENCE_MS: "1000" }))
		.toMatchObject({ conversationInitiativeSilenceMs: 1000 });
	expect(() =>
		configured({
			CONVERSATION_INITIATIVE_MODEL: "bad model",
			JEV_API_KEY: "present",
		})
	).toThrow("CONVERSATION_INITIATIVE_MODEL");
});
