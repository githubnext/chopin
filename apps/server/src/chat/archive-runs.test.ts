import { expect, test } from "bun:test";
import * as Chat from "./service";
import * as Plan from "../plan/service";
import { hostInputRoom } from "../testing/decisions";

import type { Chat as Wire } from "@chopin/protocol";
import type { Server } from "bun";
import type { SocketData } from "../wire";

let server = { publish() {} } as unknown as Server<SocketData>;

function card(id: string, status: Wire.Run["status"], waiting = 0): Wire.Run {
	return { id, name: id, status, started: 1, updated: 2, stages: [], waiting };
}

test("archiving ends every live run card, one waiting on a question included, and saves it", async () => {
	// A disconnected Planner's cards come back as it last reported them, live.
	let chat = Chat.restore(
		[],
		[card("plan", "waiting", 1), card("verify", "running"), card("earlier", "finished")],
		false,
		"down",
	);
	expect(chat.runs?.map(run => run.status)).toEqual(["waiting", "running", "finished"]);
	let saved: Wire.Run[] | undefined;
	await Chat.endRuns({
		chat,
		room: "document",
		server,
		persist: async change => {
			saved = change?.().runs;
		},
	});
	expect(saved?.map(run => [run.status, run.waiting])).toEqual([
		["stopped", 0],
		["stopped", 0],
		["finished", 0],
	]);
	expect(chat.runs).toEqual(saved);
	expect(chat.runs?.some(run => run.disconnected)).toBe(false);
});

test("an archived document opens with its runs stopped, even if a Planner hold still claims them", async () => {
	let first = await hostInputRoom();
	first.plan.chat.runs = [card("plan", "waiting", 1)];
	await Plan.persist(first.plan, () => first.plan.chat);
	await first.close();
	let reopen = { storage: first.storage, channelId: first.channelId, lease: first.lease };
	// A hold the document's archive could not end, as when it came while a deploy handed over.
	let backend = { plannerKeepsRuns: () => "down" as const };
	let live = await hostInputRoom(undefined, { ...reopen, backend });
	expect(live.plan.chat.runs?.map(run => [run.status, run.waiting])).toEqual([["waiting", 1]]);
	await live.close();
	await first.storage.channels.archive({ id: first.channelId, now: new Date() });
	let archived = await hostInputRoom(undefined, { ...reopen, backend });
	try {
		expect(archived.plan.chat.runs?.map(run => [run.status, run.waiting])).toEqual([[
			"stopped",
			0,
		]]);
	} finally {
		await archived.close();
	}
});
