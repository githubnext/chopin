import { describe, expect, it } from "bun:test";
import * as Service from "./service";
import { createProcessor } from "../conversation-plan/service";
import { hosted } from "./conversation-persistence.test-fixtures";

describe("durable conversation processing", () => {
	it("restores conversation analysis work with its saved source message", async () => {
		let context = await hosted();
		let plan = await Service.open(context.channel.id, context.backend, context.server);
		let processor = createProcessor({
			plan,
			exclusive: action => Service.exclusive(plan, action),
			persist: () => Service.persistExclusive(plan),
			publish: () => {},
			active: () => true,
		});
		await processor.accept({
			id: "message-1",
			author: { kind: "member", handle: "octocat" },
			text: "Should we use an outline?",
			ts: 1,
		});
		processor.stop();
		await Service.close(plan);

		let restored = await Service.open(context.channel.id, context.backend, context.server);
		expect(restored.chat.entries.map(entry => entry.id)).toEqual(["message-1"]);
		expect(restored.conversationPlan.queue).toEqual([{
			messageId: "message-1",
			status: "pending",
			attempts: 0,
		}]);
		await Service.close(restored);
	});
});
