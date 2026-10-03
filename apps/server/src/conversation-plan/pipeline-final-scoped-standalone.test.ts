import { expect, test } from "bun:test";
import { applyInference } from "./domain";
import { interpretMessage } from "./interpret";
import { mockResult } from "./interpret.test-fixtures";
import { message } from "./policy-initial.test-fixtures";
import { d01LinkedEditorCard } from "./pipeline-linked-option.test-fixtures";

test("a standalone Lexical spike preference opens a scoped Save and keeps the editor card open", async () => {
	let { state, threadId, options, linkedCards } = d01LinkedEditorCard();
	let lexicalId = "01M3QAQWN9TYWMFW3D0EYAZY8H";
	let text = "I’d pick Lexical for the spike";
	let current = message("standalone-lexical-spike", text, "Mei");
	let output = await interpretMessage({
		channelId: "channel",
		message: current,
		recent: [],
		state,
		linkedCards,
		ask: async request => {
			if ("new_question" in request.questions) {
				return mockResult(request.questions, {
					new_question: 0.1,
					new_option: 0.89,
					act: "proposal",
					thread_target: threadId,
					significance: 2,
					support: 0.92,
					explicit_resolution: 0.1,
				});
			}
			let overrides: Record<string, string | number> = {};
			for (let key of Object.keys(request.questions)) {
				if (key.endsWith("_role")) overrides[key] = "support";
				if (key.endsWith("_thread")) overrides[key] = threadId;
				if (/^c\d+_option$/.test(key) || key.endsWith("_chosen_option")) {
					overrides[key] = lexicalId;
				}
				if (key.endsWith("_relation")) overrides[key] = "supports";
				if (key.endsWith("_support")) overrides[key] = 0.92;
				if (key.endsWith("_new_option")) overrides[key] = 0.85;
				if (key.endsWith("_planning_substance")) overrides[key] = 0.75;
				if (key.endsWith("_duplicate")) overrides[key] = 0.05;
			}
			return mockResult(request.questions, overrides);
		},
	});
	let staged = output.events.reduce((next, event) => applyInference(next, event, current), state);
	expect(output.events.map(event => event.type)).toEqual(["scoped-choice.proposed"]);
	expect(output.events[0]).toMatchObject({
		type: "scoped-choice.proposed",
		threadId,
		optionId: lexicalId,
		label: "Lexical",
		scope: "spike",
		source: {
			messageId: current.id,
			quote: text,
			start: 0,
			end: text.length,
			role: "support",
		},
	});
	expect(staged.threads[0]!.status).toBe("exploring");
	expect(staged.threads[0]!.pendingScopedChoice).toMatchObject({
		optionId: lexicalId,
		label: "Lexical",
		scope: "spike",
	});
	expect(staged.threads[0]!.decisionHistory).toEqual([]);
	expect(staged.threads[0]!.pendingSettle).toBeUndefined();
	expect(staged.threads[0]!.contributions.filter(item => item.kind === "option")).toEqual([]);
	expect(linkedCards.get(threadId)?.options).toEqual(options);
});
