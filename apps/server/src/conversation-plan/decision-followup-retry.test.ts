import { expect, test } from "bun:test";
import { fixture } from "../questions/decision-followup.test-fixtures";
import { member } from "../questions/text-response.test-fixtures";
import { createConversationRuntime } from "./runtime";
import { handleConversationCommand } from "./commands";
import type * as Chat from "../chat/service";
import type { Room } from "../rooms";

test("a failed scoped follow-up can be retried with conversation analysis disabled", async () => {
	let context = await fixture();
	let runtime = createConversationRuntime({
		config: { agent: false, conversationPlan: false },
		server: () => context.server,
		unavailable: () => false,
	});
	let room = { id: context.plan.id, plan: context.plan, members: new Map() } as Room;
	try {
		await runtime.attach(room, context.plan, false);
		await context.save(context.ids[0]!, "Keep offline support.");
		for (let attempt = 0; attempt < 30 && !runtime.jobs(context.plan)!.jobs().length; attempt++) {
			await Bun.sleep(5);
		}
		let job = runtime.jobs(context.plan)!.jobs()[0]!;
		context.plan.conversationPlanJobs = [{
			...job,
			status: "failed",
			attempts: 1,
			reason: "The target is orphaned.",
		}];
		let actor = member();
		actor.ws.data.canEdit = true;
		await handleConversationCommand(
			{ kind: "conversation-plan:retry-job", ts: 0, rid: "retry", jobId: job.id },
			room,
			actor.ws,
			{
				enabled: false,
				runtime,
				unavailable: () => false,
				refreshAccess: async () => "allowed",
				chat: () => ({ plan: context.plan, chat: context.plan.chat, room: room.id } as Chat.Room),
			},
		);
		expect(actor.frames.at(-1)).toMatchObject({
			kind: "conversation-plan:retry-job",
			queued: true,
		});
		expect(runtime.jobs(context.plan)!.jobs()[0]!.status).toBe("pending");
	} finally {
		await runtime.stop(context.plan);
	}
});
