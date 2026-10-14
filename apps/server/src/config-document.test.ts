import { expect, test } from "bun:test";
import { configured } from "./config-conversation.test-fixtures";

test("document development is opt-in and does not need conversation classification", () => {
	expect(configured().conversationDocument).toBe(false);
	expect(configured({ CONVERSATION_DOCUMENT: "true" }).conversationDocument).toBe(false);
	expect(configured({ CONVERSATION_DOCUMENT: "on" })).toMatchObject({
		conversationDocument: true,
		conversationPlan: false,
	});
});

test("document development obeys the model and background-job switches", () => {
	for (let off of [{ AGENT: "off" }, { BACKGROUND_JOBS: "off" }]) {
		expect(configured({ CONVERSATION_DOCUMENT: "on", ...off }).conversationDocument).toBe(false);
	}
});
