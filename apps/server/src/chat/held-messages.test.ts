/**
 * What an earlier release stored for a Planner message it held for a machine: entries marked sent,
 * delivered or failed. Nothing is held now, so a document that opens with them reads them as
 * ordinary posted messages, and still opens.
 */
import { afterEach, expect, test } from "bun:test";

import * as Service from "../plan/service";
import { openPlan } from "../testing/plan";

import type { Chat } from "@chopin/protocol";

let opened: Service.Plan[] = [];
afterEach(async () => {
	for (let plan of opened.splice(0)) await Service.close(plan);
});

test("a message an earlier release marked sent, delivered or failed reads as an ordinary one when its document opens, and nothing waits for it", async () => {
	let ana = { kind: "member", handle: "ana" } as const;
	let { backend, channel, plan, server } = await openPlan("# Title\n", {
		transcript: [
			{
				id: "a",
				author: ana,
				text: "held for a machine that was away",
				ts: 1,
				deliveryState: "sent",
			},
			{ id: "b", author: ana, text: "taken by the machine", ts: 2, deliveryState: "delivered" },
			{
				id: "c",
				author: ana,
				text: "its machine was removed",
				ts: 3,
				deliveryState: "failed",
				deliveryFailure: "machine-removed",
			},
			{ id: "d", author: { kind: "agent" }, text: "On it.", ts: 4 },
		],
	});
	opened.push(plan);
	let ordinary: Chat.Entry[] = [
		{ id: "a", author: ana, text: "held for a machine that was away", ts: 1 },
		{ id: "b", author: ana, text: "taken by the machine", ts: 2 },
		{ id: "c", author: ana, text: "its machine was removed", ts: 3 },
		{ id: "d", author: { kind: "agent" }, text: "On it.", ts: 4 },
	];
	expect(plan.chat.entries).toEqual(ordinary);
	expect(plan.chat.waiting).toEqual([]);
	expect(plan.chat.busy).toBe(false);

	// Saved and opened again, they are still ordinary: the old marks are not written back.
	await Service.persist(plan);
	await Service.close(plan);
	opened.pop();
	let restored = await Service.open(channel.id, backend, server);
	opened.push(restored);
	expect(restored.chat.entries).toEqual(ordinary);
});
