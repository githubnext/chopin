import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as Y from "yjs";
import * as Service from "./service";
import { hosted } from "./conversation-persistence.test-fixtures";
import { socket } from "./projection-submit.test-fixtures";

import type { Mock } from "bun:test";

let clock = 1_800_000_000_000;
let spies: Array<Mock<(...args: never[]) => unknown>> = [];

afterEach(() => {
	for (let spy of spies) spy.mockRestore();
	spies = [];
});

/** One window's worth of updates, plus `extra` past the limit. */
function burst(plan: Service.Plan, ws: ReturnType<typeof socket>, extra: number): void {
	let update = Buffer.from(Y.encodeStateAsUpdate(new Y.Doc())).toString("base64");
	for (let i = 0; i < 200 + extra; i++) {
		Service.submit(plan, ws, {
			kind: "plan:update",
			ts: 0,
			rid: `rid-${clock}-${i}`,
			id: `id-${clock}-${i}`,
			epoch: plan.document.epoch,
			update,
		});
	}
}

async function setup() {
	spies.push(spyOn(Date, "now").mockImplementation(() => clock) as never);
	let warnings: string[] = [];
	spies.push(
		spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
			warnings.push(args.join(" "));
		}) as never,
	);
	let context = await hosted();
	let plan = await Service.open(context.channel.id, context.backend, context.server);
	let frames: Array<Record<string, unknown>> = [];
	let closed: Array<[number, string]> = [];
	let ws = socket(context, frames);
	ws.close = ((code: number, reason: string) => void closed.push([code, reason])) as never;
	return { plan, ws, frames, closed, warnings };
}

describe("plan update rate limit", () => {
	it("refuses updates over the limit, and says so once per window", async () => {
		let { plan, ws, frames, closed, warnings } = await setup();
		try {
			burst(plan, ws, 5);
			await Bun.sleep(20);
			await plan.flushing;

			let refused = frames.filter(frame => frame.kind === "session:error");
			expect(refused).toHaveLength(5);
			expect(refused[0]).toMatchObject({ message: "rate limited", rid: `rid-${clock}-200` });
			expect(frames.filter(frame => frame.kind === "plan:ack")).toHaveLength(200);
			expect(warnings.filter(line => line.includes("dropping updates"))).toHaveLength(1);
			expect(closed).toEqual([]);
		} finally {
			await Service.close(plan);
		}
	});

	it("closes a connection that stays over the limit, so it reconnects and replays", async () => {
		let { plan, ws, closed, warnings } = await setup();
		try {
			for (let window = 0; window < 3; window++) {
				burst(plan, ws, 1);
				await Bun.sleep(20);
				await plan.flushing;
				if (window < 2) expect(closed).toEqual([]);
				clock += 1_000;
			}

			expect(closed).toEqual([[4429, "plan updates too fast"]]);
			expect(warnings.filter(line => line.includes("dropping updates"))).toHaveLength(3);
		} finally {
			await Service.close(plan);
		}
	});

	it("starts counting again after a quiet window", async () => {
		let { plan, ws, closed } = await setup();
		try {
			for (let window = 0; window < 3; window++) {
				burst(plan, ws, 1);
				await Bun.sleep(20);
				await plan.flushing;
				clock += window === 0 ? 5_000 : 1_000;
			}

			expect(closed).toEqual([]);
		} finally {
			await Service.close(plan);
		}
	});
});
