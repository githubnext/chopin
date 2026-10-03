import { installJobCleanup } from "./job.test-fixtures";
import { expect, test } from "bun:test";
import * as Chat from "./service";
import * as Service from "../plan/service";
import { openPlan } from "../testing/plan";
import type { Chat as Wire } from "@chopin/protocol";

installJobCleanup();

test("a committed notice survives a failed post-commit broadcast", async () => {
	let opened = await openPlan();
	opened.breakRelay("chat:message");
	try {
		let entry = await Chat.notice({
			chat: opened.plan.chat,
			plan: opened.plan,
			server: opened.server,
			room: opened.channel.id,
		}, "The Planner refined this decision.");
		let stored = await opened.storage.collaboration.load(opened.channel.id, opened.now);
		let sidecar = stored?.sidecar ?? stored?.snapshot?.sidecar;
		expect((sidecar as { transcript: Wire.Entry[] }).transcript).toContainEqual(entry);
	} finally {
		await Service.close(opened.plan);
	}
});
