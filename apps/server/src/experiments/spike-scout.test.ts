import { expect, test } from "bun:test";

import { FOLLOW_UP_MS, jevJudge, SpikeScout } from "./spike-scout";

import type { Investigation } from "@chopin/experiment/records";
import type { SpikeBlock, SpikeHost, SpikeJudge, SpikeSnapshot } from "./spike-scout";

function block(
	digest: string,
	text = `Passage ${digest} is unsure whether this works.`,
): SpikeBlock {
	return { digest, text };
}

function harness(snapshot: Partial<SpikeSnapshot> = {}, verdict?: SpikeJudge) {
	let started: string[] = [];
	let dismissed: string[] = [];
	let judged: string[][] = [];
	let records: Investigation[] = [];
	let connected = true;
	let timers: Array<() => void> = [];
	let delays: number[] = [];
	let state: SpikeSnapshot = {
		repositoryId: "R_1",
		live: false,
		blocks: [],
		callouts: new Set(),
		...snapshot,
	};
	let host: SpikeHost = {
		snapshot: async () => state,
		spikes: async () => records,
		connection: async () => connected ? { id: "C_1", login: "maggie" } : undefined,
		start: async (_id, input) => {
			started.push(input.block.digest);
			state.callouts.add(`CALLOUT${input.block.digest}`);
			records.push({
				state: "running",
				spike: {
					digest: input.block.digest,
					callout: `CALLOUT${input.block.digest}`,
					placed: true,
				},
			} as Investigation);
		},
		dismiss: async (_id, id) => {
			dismissed.push(id);
		},
		refresh: async () => {},
	};
	let scout = new SpikeScout({
		host,
		judge: async blocks => {
			judged.push(blocks.map(item => item.digest));
			return verdict ? verdict(blocks) : blocks.map(item => item.text.includes("unsure"));
		},
		after: (delay, action) => {
			delays.push(delay);
			timers.push(action);
			return () => {};
		},
	});
	return {
		scout,
		state,
		started,
		dismissed,
		judged,
		records,
		timers,
		delays,
		disconnect: () => connected = false,
		reconnect: () => connected = true,
	};
}

test("a settled edit starts spikes for uncertain passages and never re-judges them", async () => {
	let h = harness({
		blocks: [block("a"), block("b", "A settled descriptive paragraph about lists.")],
	});
	h.scout.schedule({ channelId: "D", editor: "U_1" });
	expect(h.timers).toHaveLength(1);
	h.timers[0]();
	await h.scout.check("D");
	expect(h.started).toEqual(["a"]);
	expect(h.judged).toEqual([["a", "b"]]);
	await h.scout.check("D");
	expect(h.judged).toHaveLength(1);
	expect(h.started).toEqual(["a"]);
});

test("edits by the server alone never schedule a scan", () => {
	let h = harness({ blocks: [block("a")] });
	h.scout.schedule({ channelId: "D" });
	expect(h.timers).toHaveLength(0);
});

test("a scan judges at most five passages and keeps three spikes active", async () => {
	let h = harness({ blocks: ["a", "b", "c", "d", "e", "f", "g"].map(digest => block(digest)) });
	h.scout.schedule({ channelId: "D", editor: "U_1" });
	await h.scout.check("D");
	expect(h.judged[0]).toEqual(["a", "b", "c", "d", "e"]);
	expect(h.started).toEqual(["a", "b", "c"]);
	await h.scout.check("D");
	expect(h.judged).toHaveLength(1);
	expect(h.dismissed).toEqual([]);
});

test("a living build stops the scout", async () => {
	let h = harness({ live: true, blocks: [block("a")] });
	h.scout.schedule({ channelId: "D", editor: "U_1" });
	await h.scout.check("D");
	expect(h.judged).toHaveLength(0);
	expect(h.started).toHaveLength(0);
});

test("without the editor's local agent nothing starts and nothing is judged", async () => {
	let h = harness({ blocks: [block("a")] });
	h.disconnect();
	h.scout.schedule({ channelId: "D", editor: "U_1" });
	await h.scout.check("D");
	expect(h.judged).toHaveLength(0);
	expect(h.started).toHaveLength(0);
});

test("a removed callout dismisses its spike and the passage never re-triggers", async () => {
	let h = harness({ blocks: [block("a")] });
	h.records.push({
		id: "X",
		state: "running",
		spike: { digest: "a", callout: "GONE", placed: true },
	} as Investigation);
	h.scout.schedule({ channelId: "D", editor: "U_1" });
	await h.scout.check("D");
	expect(h.dismissed).toEqual(["X"]);
	expect(h.started).toEqual([]);
	expect(h.judged).toHaveLength(0);
});

test("Jev decides at 0.6 and a failure decides nothing", async () => {
	let asked = 0;
	let judge = jevJudge(async request => {
		asked++;
		expect(Object.keys(request.questions)).toEqual(["spike_0", "spike_1"]);
		return {
			model: "jev",
			answers: {
				spike_0: { type: "noul", noul: 0.61 },
				spike_1: { type: "noul", noul: 0.59 },
			},
			usage: { input_tokens: 1, output_tokens: 1 },
			latencyMs: 1,
		};
	});
	let blocks = [block("a", "Plain text."), block("b")];
	expect(await judge(blocks)).toEqual([true, false]);
	expect(asked).toBe(1);
	let failing = jevJudge(async () => {
		throw new Error("timeout");
	});
	expect(await failing(blocks)).toBeUndefined();
});

test("a judge that cannot decide leaves every passage to be judged again", async () => {
	let h = harness({ blocks: [block("a")] }, async () => undefined);
	h.scout.schedule({ channelId: "D", editor: "U_1" });
	await h.scout.check("D");
	await h.scout.check("D");
	expect(h.judged).toEqual([["a"], ["a"]]);
	expect(h.started).toEqual([]);
});

test("approved passages over capacity are started by a later scan", async () => {
	let h = harness({ blocks: ["a", "b", "c", "d"].map(digest => block(digest)) });
	h.scout.schedule({ channelId: "D", editor: "U_1" });
	await h.scout.check("D");
	expect(h.started).toEqual(["a", "b", "c"]);
	h.records[0].state = "completed";
	await h.scout.check("D");
	expect(h.judged[1]).toEqual(["d"]);
	expect(h.started).toEqual(["a", "b", "c", "d"]);
});

test("a living build still dismisses a deleted callout's spike", async () => {
	let h = harness({ live: true, blocks: [block("a")] });
	h.records.push({
		id: "X",
		state: "running",
		spike: { digest: "a", callout: "GONE", placed: true },
	} as Investigation);
	h.scout.schedule({ channelId: "D", editor: "U_1" });
	await h.scout.check("D");
	expect(h.dismissed).toEqual(["X"]);
	expect(h.judged).toHaveLength(0);
});

test("a scan that leaves passages unjudged looks at the next batch shortly", async () => {
	let digests = ["a", "b", "c", "d", "e", "f", "g"];
	let h = harness(
		{ blocks: digests.map(digest => block(digest, `Settled passage ${digest} about lists.`)) },
	);
	h.scout.schedule({ channelId: "D", editor: "U_1" });
	h.timers[0]();
	await Bun.sleep(1);
	expect(h.judged).toEqual([["a", "b", "c", "d", "e"]]);
	expect(h.delays.at(-1)).toBe(FOLLOW_UP_MS);
	h.timers.at(-1)!();
	await Bun.sleep(1);
	expect(h.judged[1]).toEqual(["f", "g"]);
	// Everything has been judged, so no further follow-up is scheduled.
	let scheduled = h.timers.length;
	await h.scout.check("D");
	expect(h.timers).toHaveLength(scheduled);
});

test("a rewritten passage directly above a spike callout is not spiked again", async () => {
	let h = harness({
		blocks: [
			{ ...block("a2"), calloutAfter: "CALLOUTa" },
			{ ...block("b"), calloutAfter: "SOMEONE_ELSES" },
		],
		callouts: new Set(["CALLOUTa", "SOMEONE_ELSES"]),
	});
	h.records.push({
		id: "X",
		state: "completed",
		spike: { digest: "a", callout: "CALLOUTa", placed: true },
	} as Investigation);
	h.scout.schedule({ channelId: "D", editor: "U_1" });
	await h.scout.check("D");
	expect(h.judged).toEqual([["b"]]);
	expect(h.started).toEqual(["b"]);
});

test("deleting a callout stops its spike on the edit, before the scan", async () => {
	let h = harness({ blocks: [block("a")] });
	h.records.push({
		id: "X",
		state: "running",
		spike: { digest: "a", callout: "GONE", placed: true },
	} as Investigation);
	h.scout.schedule({ channelId: "D", editor: "U_1" });
	h.scout.schedule({ channelId: "D", editor: "U_1" });
	await Bun.sleep(0);
	await h.scout.refresh("D");
	expect(h.dismissed).toEqual(["X"]);
	expect(h.judged).toHaveLength(0);
});

test("passages waiting at the active-spike cap are judged when a spike frees capacity", async () => {
	let asked: string[][] = [];
	let judge = jevJudge(async request => {
		let passages = (request.state as { passages: Array<{ key: string }> }).passages;
		asked.push(passages.map(passage => passage.key));
		return {
			answers: Object.fromEntries(
				passages.map(passage => [passage.key, { type: "noul", noul: 0.9 }]),
			),
		} as never;
	});
	let h = harness(
		{ blocks: ["a", "b", "c", "d", "e", "f", "g"].map(digest => block(digest)) },
		judge,
	);
	h.scout.schedule({ channelId: "D", editor: "U_1" });
	h.timers[0]();
	await Bun.sleep(1);
	expect(h.started).toEqual(["a", "b", "c"]);
	// The follow-up for f and g finds no capacity and judges nothing.
	h.timers.at(-1)!();
	await Bun.sleep(1);
	expect(h.judged).toHaveLength(1);
	// A refresh while every spike is still active changes nothing.
	await h.scout.refresh("D");
	expect(h.judged).toHaveLength(1);
	h.records[1].state = "failed";
	await h.scout.refresh("D");
	expect(h.judged[1]).toEqual(["d", "e", "f", "g"]);
	expect(h.started).toEqual(["a", "b", "c", "d"]);
	h.records[0].state = "completed";
	await h.scout.refresh("D");
	expect(h.started).toEqual(["a", "b", "c", "d", "e"]);
	expect(asked).toHaveLength(3);
});

test("a reconnecting local agent rescans its owner's documents missed while it was away", async () => {
	let h = harness({ blocks: [block("a")] });
	h.disconnect();
	h.scout.schedule({ channelId: "D", editor: "U_1" });
	h.timers[0]();
	await h.scout.check("D");
	expect(h.started).toEqual([]);
	h.reconnect();
	h.scout.connected("R_2", "U_1");
	h.scout.connected("R_1", "U_2");
	await new Promise(resolve => setTimeout(resolve, 0));
	expect(h.started).toEqual([]);
	h.scout.connected("R_1", "U_1");
	await new Promise(resolve => setTimeout(resolve, 0));
	expect(h.started).toEqual(["a"]);
});

test("a reconnect rescans only documents its owner's scan could not serve", async () => {
	let h = harness({ blocks: [block("a")] });
	h.disconnect();
	h.scout.schedule({ channelId: "D", editor: "U_1" });
	h.timers[0]();
	await h.scout.check("D");
	h.reconnect();
	let checks = 0;
	let original = h.scout.check.bind(h.scout);
	h.scout.check = id => {
		checks++;
		return original(id);
	};
	h.scout.connected("R_1", "U_1");
	await new Promise(resolve => setTimeout(resolve, 0));
	expect(checks).toBe(1);
	expect(h.started).toEqual(["a"]);
	h.scout.connected("R_1", "U_1");
	expect(checks).toBe(1);
});
