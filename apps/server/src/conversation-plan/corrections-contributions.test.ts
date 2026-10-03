import { describe, expect, test } from "bun:test";
import type { ConversationPlan } from "@chopin/protocol";
import { initialState, replay, restoreState } from "./domain";
import { buildTargetingRequest, QUESTION_SET_VERSION } from "./questions";
import { extractQuotes } from "./quotes";
import { add, correct, message, open, stance } from "./corrections.test-fixtures";

// Original callbacks/data: archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2,
// apps/server/src/conversation-plan/corrections.test.ts.

describe("conversation card contribution corrections", () => {
	test("retargets reasons and constraints with exact wording and source attribution", () => {
		let state = add(add(open(initialState()), "option", "a"), "option", "b");
		state = add(state, "reason", "reason", "a");
		state = add(state, "constraint", "constraint", "t1");
		let original = structuredClone(state.threads[0].contributions.slice(-2));
		state = correct(state, "reason-to-thread", {
			kind: "retarget-contribution",
			contributionId: "reason",
			targetId: "t1",
		});
		state = correct(state, "constraint-to-b", {
			kind: "retarget-contribution",
			contributionId: "constraint",
			targetId: "b",
		});
		let changed = state.threads[0].contributions.slice(-2);
		for (let index = 0; index < 2; index++) {
			expect(changed[index]).toEqual({
				...original[index],
				targetId: index === 0 ? "t1" : "b",
				targetEditedBy: "bob",
			});
		}
		expect(replay(state.events).threads).toEqual(state.threads);
		expect(restoreState(JSON.parse(JSON.stringify(state))).threads).toEqual(
			JSON.parse(JSON.stringify(state.threads)),
		);
		let forged = JSON.parse(JSON.stringify(state));
		forged.threads[0].contributions.find((item: { id: string }) => item.id === "reason")
			.targetEditedBy = "mallory";
		expect(() => restoreState(forged)).toThrow(/snapshot/i);
		let invalid = structuredClone(state);
		(invalid.events.at(-1) as any).change.extra = "unknown";
		expect(() => restoreState(invalid)).toThrow(/unknown/i);
	});

	test("rejects wrong contribution kinds, foreign targets, overlong IDs and stale versions", () => {
		let state = add(open(initialState()), "option", "a");
		state = add(state, "reason", "reason", "a");
		state = open(state, "t2");
		state = add(state, "option", "foreign", undefined, "t2");
		let before = structuredClone(state);
		for (
			let change of [
				{ kind: "retarget-contribution", contributionId: "a", targetId: "t1" },
				{ kind: "retarget-contribution", contributionId: "reason", targetId: "t2" },
				{ kind: "retarget-contribution", contributionId: "reason", targetId: "foreign" },
				{ kind: "retarget-contribution", contributionId: "reason", targetId: "a" },
				{ kind: "retarget-contribution", contributionId: "reason", targetId: "x".repeat(201) },
			] as ConversationPlan.CorrectionChange[]
		) {
			expect(() => correct(state, "invalid-target", change)).toThrow();
		}
		expect(() =>
			correct(state, "stale-target", {
				kind: "retarget-contribution",
				contributionId: "reason",
				targetId: "t1",
			}, state.threads[0].version - 1)
		).toThrow(/stale/i);
		expect(state).toEqual(before);
	});

	test("later Jev context uses bounded corrected targets and current stances", () => {
		let state = add(add(open(initialState()), "option", "a"), "reason", "reason", "t1");
		for (let index = 0; index < 15; index++) {
			state = add(state, "reason", `other-${index}`, "t1");
		}
		state = stance(state, "chat020-stance", "a");
		state = correct(state, "retarget-chat020", {
			kind: "retarget-stance",
			stanceId: "chat020-stance",
		});
		state = correct(state, "retarget-reason", {
			kind: "retarget-contribution",
			contributionId: "reason",
			targetId: "a",
		});
		let next = message("next", "What follows from that?");
		let request = buildTargetingRequest(next, [], state.threads, extractQuotes(next.text));
		let context = (request.state as {
			threads: Array<{
				stances: Array<{ participant: string; optionId?: string; position: string }>;
				contributions: Array<{ id: string; targetId: string; relation: string }>;
			}>;
		}).threads[0];
		expect(QUESTION_SET_VERSION).toBe("conversation-plan-8");
		expect(context.stances).toEqual([{
			participant: "alice",
			optionId: undefined,
			position: "oppose",
		}]);
		expect(context.contributions).toHaveLength(4);
		expect(context.contributions[0]).toMatchObject({
			id: "reason",
			targetId: "a",
			relation: "qualifies",
		});
		expect(state.events.some((event) => event.id === "chat020-stance")).toBe(true);
	});
});
