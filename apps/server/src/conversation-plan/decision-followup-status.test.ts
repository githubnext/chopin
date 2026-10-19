import { expect, test } from "bun:test";
import { writeup } from "./prose-job";
import { appendFollowupEffect } from "../questions/decision-followup";
import { CARD, record } from "./prose-job.test-fixtures";

test("marked Planner captures expose pending, failed and completed-receipt write-up state", () => {
	let saved = record({ origin: "planner", followUp: { scope: "scope", target: [] } });
	let id = `decision-followup:${CARD}:decided:${CARD}:1`;
	let jobs = (status: "pending" | "failed" | "done") => ({
		conversationPlanPendingEffects: [],
		conversationPlanJobs: [{
			id,
			kind: "decision-followup" as const,
			target: CARD,
			trigger: `decided:${CARD}:1`,
			status,
			attempts: 1,
			at: "2026-10-19T00:00:00.000Z",
		}],
	});
	expect(writeup(jobs("pending"), saved)).toEqual({ status: "writing", job: id });
	expect(writeup(jobs("failed"), saved)).toEqual({ status: "failed", job: id });
	expect(writeup(jobs("done"), saved)).toBeUndefined();
	expect(
		writeup({
			conversationPlanJobs: [],
			conversationPlanPendingEffects: appendFollowupEffect([], [], saved),
		}, saved),
	)
		.toEqual({ status: "writing", job: id });
	expect(
		writeup(
			jobs("failed"),
			record({ origin: "planner", followUp: { scope: "scope", target: [], appliedGeneration: 1 } }),
		),
	)
		.toBeUndefined();
	expect(writeup(jobs("failed"), record({ origin: "planner" }))).toBeUndefined();
});
