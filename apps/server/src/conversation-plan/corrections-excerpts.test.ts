import { describe, expect, test } from "bun:test";
import type { ConversationPlan } from "@chopin/protocol";
import { initialState } from "./domain";
import {
	add,
	bob,
	correctExcerpt,
	message,
	open,
	reviewedExcerpt,
} from "./corrections.test-fixtures";

// Original callbacks/data: archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2,
// apps/server/src/conversation-plan/corrections.test.ts.

describe("conversation card excerpt corrections", () => {
	test.each(
		[
			{
				kind: "option",
				text: "Postmark handles email delivery.",
				targetOptionId: undefined,
				targetId: "t1",
			},
			{ kind: "reason", text: "SQS is operationally simple.", targetOptionId: "a", targetId: "a" },
			{
				kind: "constraint",
				text: "Must stay inside our VPC.",
				targetOptionId: undefined,
				targetId: "t1",
			},
		] as const,
	)("adds a held $kind excerpt with original source and human correction actor", ({
		kind,
		text,
		targetOptionId,
		targetId,
	}) => {
		let state = add(open(initialState()), "option", "a");
		let original = message("held-chat", `I think ${text} Please review.`);
		let start = original.text.indexOf(text);
		let end = start + text.length;
		state = reviewedExcerpt(state, original, 0, original.text.length, "ignored");
		let action = {
			actionId: `correct-${kind}`,
			threadId: "t1",
			expectedVersion: state.threads[0]!.version,
			change: {
				kind: "add-excerpt",
				messageId: original.id,
				start,
				end,
				contributionKind: kind,
				targetOptionId,
			},
		} as unknown as ConversationPlan.CorrectionAction;
		let changed = correctExcerpt(state, action, original);
		let added = changed.threads[0]!.contributions.at(-1)!;
		let excerpt = text;
		let sourceRef = {
			messageId: original.id,
			author: original.author,
			quote: excerpt,
			start,
			end,
			role: kind,
		};
		expect(added).toMatchObject({
			kind,
			text: excerpt,
			targetId,
			authoring: "quoted",
			actor: bob,
			sources: [sourceRef],
		});
		expect(changed.events.at(-1)).toMatchObject({
			type: `${kind}.added`,
			origin: "human",
			actor: bob,
			source: sourceRef,
			contribution: { text: excerpt, targetId },
		});
		expect(changed.analysis.at(-1)?.outcomes?.[0]?.status).toBe("ignored");
		expect(changed.revision).toBe(state.revision + 1);
	});

	test("replaying an excerpt correction action ID is idempotent", () => {
		let state = add(open(initialState()), "option", "a");
		let original = message("held-retry", "SQS is operationally simple.");
		state = reviewedExcerpt(state, original, 0, original.text.length);
		let action = {
			actionId: "correct-retry",
			threadId: "t1",
			expectedVersion: state.threads[0]!.version,
			change: {
				kind: "add-excerpt",
				messageId: original.id,
				start: 0,
				end: original.text.length,
				contributionKind: "reason",
				targetOptionId: "a",
			},
		} as unknown as ConversationPlan.CorrectionAction;
		let changed = correctExcerpt(state, action, original);
		expect(correctExcerpt(changed, action, original)).toBe(changed);
		expect(changed.events.filter(event => event.origin === "human")).toHaveLength(1);
	});
});
