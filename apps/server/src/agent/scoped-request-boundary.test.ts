import { expect, spyOn, test } from "bun:test";
import { createScopedTools } from "./scoped-tools";
import { documentRoom } from "./heading-harness.test-fixtures";
import { openPlan } from "../testing/plan";
import * as Service from "../plan/service";
import * as Questions from "../questions/service";
import * as Room from "../plan/room";

test("raw transcript request state cannot authorize a direct tool without its verified provider", async () => {
	let context = await openPlan("Opening prose.\n");
	let errors = spyOn(console, "error").mockImplementation(() => {});
	try {
		let id = await Questions.insertConversationCard(context.plan, context.server, "test", {
			threadId: "thread-a",
			header: "Authentication",
			question: "Which authentication system?",
			options: [],
		});
		context.plan.chat.turn = { id: "current-turn", handle: "ana", started: 1, responded: false };
		context.plan.chat.activeRequest = {
			entryId: "old-entry",
			userId: "U_test",
			handle: "ana",
			claimantSessionId: "old-session",
			turnId: "old-turn",
			lifecycle: context.plan.chat.lifecycle - 1,
			text: "@chopin revise the question for the Authentication decision",
		};
		let room = documentRoom(context);
		expect(room.currentMemberRequest).toBeUndefined();
		let before = Room.project(context.plan.document);
		let record = structuredClone(context.plan.records.get(id));
		let revision = context.plan.revision;
		let result = await createScopedTools().revise_open_decision.execute!({
			revision,
			id,
			title: "Authentication choice",
		}, { context: { room }, toolCallId: "raw-request", messages: [] });
		expect(result).toBe("Error: a direct current member request is required");
		expect(Room.project(context.plan.document)).toBe(before);
		expect(context.plan.records.get(id)).toEqual(record);
		expect(context.plan.revision).toBe(revision);
	} finally {
		errors.mockRestore();
		await Service.close(context.plan);
	}
});
