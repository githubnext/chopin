import { expect, test } from "bun:test";
import { configured } from "./config-conversation.test-fixtures";

test("only the exact opt-in enables analysis", () => {
	for (let flag of [undefined, "", "off", "ON", "true", "1"]) {
		expect(configured({ CONVERSATION_PLAN: flag })).toMatchObject({
			conversationPlan: false,
			decisionsModel: "typesafe/jev-latest",
			decisionsTimeoutMs: 30_000,
		});
	}
	expect(() => configured({ CONVERSATION_PLAN: "on", JEV_API_KEY: "" }))
		.toThrow("A decisions model is required when CONVERSATION_PLAN=on");
});

test("timeout bounds are validated even when conversation analysis is off", () => {
	for (let timeout of ["100", "60000", "000100"]) {
		expect(configured({ DECISIONS_TIMEOUT_MS: timeout }).decisionsTimeoutMs)
			.toBe(Number(timeout));
	}
	for (let timeout of ["99", "60001", "-100", "+100", " 100", "100 ", "1e3", "9007199254740992"]) {
		expect(() => configured({ DECISIONS_TIMEOUT_MS: timeout })).toThrow("DECISIONS_TIMEOUT_MS");
	}
});
