import { expect, test } from "bun:test";

import { finishTurns } from "./turns";

type Chat = { name: string; running: boolean; ended: PromiseWithResolvers<void> };

function chat(name: string): Chat {
	return { name, running: true, ended: Promise.withResolvers<void>() };
}

function turns(chats: Chat[], events: string[]) {
	return {
		busy: () => chats.filter(item => item.running),
		interrupt(item: Chat) {
			events.push(`interrupt ${item.name}`);
			item.running = false;
			item.ended.resolve();
		},
		settled: (item: Chat) => item.ended.promise,
		beforeInterrupt: () => events.push("beforeInterrupt"),
	};
}

test("it waits for running turns and cuts none off when they finish in time", async () => {
	let events: string[] = [];
	let one = chat("one");
	setTimeout(() => {
		one.running = false;
		one.ended.resolve();
	}, 40);
	let started = performance.now();
	expect(await finishTurns(turns([one], events), { waitMs: 2_000, poll: 5 })).toBe(0);
	expect(performance.now() - started).toBeLessThan(500);
	expect(events).toEqual([]);
});

test("it does not wait at all when no turn is running", async () => {
	let started = performance.now();
	expect(await finishTurns(turns([], []), { waitMs: 5_000, poll: 5 })).toBe(0);
	expect(performance.now() - started).toBeLessThan(100);
});

test("a turn still running at the limit is cut off after the Planner's links are told, and not before", async () => {
	let events: string[] = [];
	let slow = chat("slow");
	let started = performance.now();
	let cut = await finishTurns(turns([slow], events), { waitMs: 60, poll: 5 });
	expect(cut).toBe(1);
	expect(performance.now() - started).toBeGreaterThanOrEqual(55);
	expect(events).toEqual(["beforeInterrupt", "interrupt slow"]);
});

test("every turn still running is cut off, and the notice is given only its bound to be recorded", async () => {
	let events: string[] = [];
	let first = chat("first");
	let stuck = chat("stuck");
	let source = turns([first, stuck], events);
	source.interrupt = item => {
		events.push(`interrupt ${item.name}`);
		if (item === first) {
			item.running = false;
			item.ended.resolve();
		}
	};
	let started = performance.now();
	expect(await finishTurns(source, { waitMs: 10, poll: 5, settleMs: 80 })).toBe(2);
	expect(performance.now() - started).toBeLessThan(500);
	expect(events).toEqual(["beforeInterrupt", "interrupt first", "interrupt stuck"]);
});
