import { expect, test } from "bun:test";
import { machineFeed, machinesLabel, summarizeMachines, updateAvailable } from "./machine-summary";

let machine = (connected: boolean) => ({ connected });

test("the summary counts paired machines and those connected now", () => {
	expect(summarizeMachines([])).toEqual({ paired: 0, connected: 0 });
	expect(summarizeMachines([machine(true), machine(false), machine(true)])).toEqual({
		paired: 3,
		connected: 2,
	});
});

test("the Machines entry names how many machines are connected", () => {
	expect(machinesLabel(undefined)).toBe("Machines");
	expect(machinesLabel({ paired: 0, connected: 0 })).toBe("Machines, none connected");
	expect(machinesLabel({ paired: 1, connected: 1 })).toBe("Machines, 1 connected");
	expect(machinesLabel({ paired: 2, connected: 2 })).toBe("Machines, 2 connected");
});

test("the name repeats the visible count when some paired machines are offline", () => {
	expect(machinesLabel({ paired: 2, connected: 1 })).toBe("Machines, 2 paired, 1 connected");
	expect(machinesLabel({ paired: 1, connected: 0 })).toBe("Machines, 1 paired, none connected");
});

test("a machine has an update when its release is older than the one the server recommends", () => {
	expect(updateAvailable("0.1.2", "0.1.3")).toBe(true);
	expect(updateAvailable("0.9.9", "0.10.0")).toBe(true);
	expect(updateAvailable("0.1.3-rc.1", "0.1.3")).toBe(true);
	expect(updateAvailable("0.1.3", "0.1.3")).toBe(false);
	expect(updateAvailable("0.2.0", "0.1.3")).toBe(false);
	// Without both releases there is nothing to compare.
	expect(updateAvailable(null, "0.1.3")).toBe(false);
	expect(updateAvailable("0.1.2", null)).toBe(false);
});

function machineOf(id: string, connected: boolean) {
	return { id, connected } as import("./machine-summary").Machine;
}

test("the live list is asked again every few seconds while something polls, and stops after", async () => {
	let answers = 0;
	let online = true;
	let feed = machineFeed(async () => {
		answers++;
		return [machineOf("box", online)];
	}, { interval: 20 });
	let heard: boolean[] = [];
	let initial = Promise.withResolvers<void>();
	let refreshed = Promise.withResolvers<void>();
	let unwatch = feed.watch(() => {
		heard.push(feed.snapshot().machines![0]!.connected);
		if (heard.length === 1) initial.resolve();
		if (heard.length === 3) refreshed.resolve();
	});
	let stop = feed.poll();
	let stopped = false;
	try {
		await initial.promise;
		expect(answers).toBe(1);
		online = false;
		await refreshed.promise;
		expect(answers).toBe(3);
		expect(heard).toEqual([true, false, false]);
		stop();
		stopped = true;
		let after = answers;
		await Bun.sleep(60);
		expect(answers).toBe(after);
	} finally {
		unwatch();
		if (!stopped) stop();
	}
});

test("two pollers share one list, which keeps polling until both stop", async () => {
	let answers = 0;
	let feed = machineFeed(async () => (answers++, []), { interval: 20 });
	let initial = Promise.withResolvers<void>();
	let refreshed = Promise.withResolvers<void>();
	let heard = 0;
	let unwatch = feed.watch(() => {
		if (++heard === 1) initial.resolve();
		if (heard === 2) refreshed.resolve();
	});
	let first = feed.poll();
	let second = feed.poll();
	first();
	let stopped = false;
	try {
		await initial.promise;
		let before = answers;
		await refreshed.promise;
		expect(answers).toBeGreaterThan(before);
		second();
		stopped = true;
		let after = answers;
		await Bun.sleep(50);
		expect(answers).toBe(after);
	} finally {
		unwatch();
		if (!stopped) second();
	}
});

test("a failed answer keeps the list it had and says why; a hidden page asks nothing", async () => {
	let fail = false;
	let visible = true;
	let answers = 0;
	let feed = machineFeed(async () => {
		answers++;
		if (fail) throw new Error("unavailable");
		return [machineOf("box", true)];
	}, { visible: () => visible });
	await feed.load();
	fail = true;
	await feed.load();
	expect(feed.snapshot()).toEqual({ machines: [machineOf("box", true)], error: "unavailable" });
	visible = false;
	await feed.load();
	expect(answers).toBe(2);
	feed.update(list => list.filter(machine => machine.id !== "box"));
	expect(feed.snapshot().machines).toEqual([]);
});
