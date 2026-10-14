import { expect, test } from "bun:test";
import { configured } from "./config-conversation.test-fixtures";

test("automatic participation is independent, opt-in, and disabled with the Planner", () => {
	expect(configured().conversationInitiative).toBe(false);
	expect(configured({ CONVERSATION_INITIATIVE: "on", AGENT: "off" }))
		.toMatchObject({ agent: false, conversationInitiative: false });
	expect(() => configured({ CONVERSATION_INITIATIVE: "on" })).toThrow("JEV_API_KEY");
	expect(configured({ CONVERSATION_INITIATIVE: "on", JEV_API_KEY: "present" }))
		.toMatchObject({
			conversationPlan: false,
			conversationInitiative: true,
			conversationInitiativeSilenceMs: 15_000,
			conversationInitiativeModel: "jev-1.13.0",
		});
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
			CONVERSATION_INITIATIVE: "on",
			CONVERSATION_INITIATIVE_MODEL: "bad model",
			JEV_API_KEY: "present",
		})
	).toThrow("CONVERSATION_INITIATIVE_MODEL");
});
