import { expect, test } from "bun:test";
import {
	allMachines,
	machineFeed,
	machinesLabel,
	ownerHint,
	summarizeLive,
	summarizeMachines,
	updateAvailable,
} from "./machine-summary";

import type { TeammateMachine } from "./machine-summary";

let machine = (connected: boolean) => ({ connected });

test("the summary counts machines and those connected now", () => {
	expect(summarizeMachines([])).toEqual({ total: 0, connected: 0 });
	expect(summarizeMachines([machine(true), machine(false), machine(true)])).toEqual({
		total: 3,
		connected: 2,
	});
});

test("the Machines entry names how many machines are connected", () => {
	expect(machinesLabel(undefined)).toBe("Machines");
	expect(machinesLabel({ total: 0, connected: 0 })).toBe("Machines, none connected");
	expect(machinesLabel({ total: 1, connected: 1 })).toBe("Machines, 1 connected");
	expect(machinesLabel({ total: 2, connected: 2 })).toBe("Machines, 2 connected");
});

test("the name repeats the visible total when some machines are offline", () => {
	expect(machinesLabel({ total: 2, connected: 1 })).toBe("Machines, 1 of 2 connected");
	expect(machinesLabel({ total: 1, connected: 0 })).toBe("Machines, none of 1 connected");
	expect(machinesLabel({ total: 3, connected: 0 })).toBe("Machines, none of 3 connected");
});

const shared: TeammateMachine = {
	id: "theirs",
	label: "build-box",
	teammate: true,
	owner: { login: "rival", avatarUrl: "" },
	repositories: ["octo-org/score"],
	connected: true,
	createdAt: 1_000,
	lastSeenAt: 1,
	version: null,
	service: false,
	favorite: false,
};

test("the count includes teammates' shared machines, so one own and one shared, both connected, are 2 of 2", () => {
	let own = [{ ...machine(true), id: "mine" }] as never;
	let live = { machines: own, teammates: [shared], error: "" };
	expect(summarizeLive(live)).toEqual({ total: 2, connected: 2 });
	expect(machinesLabel(summarizeLive(live))).toBe("Machines, 2 connected");
	// An offline shared machine counts in the total only.
	let offline = { ...live, teammates: [{ ...shared, connected: false }] };
	expect(summarizeLive(offline)).toEqual({ total: 2, connected: 1 });
	expect(machinesLabel(summarizeLive(offline))).toBe("Machines, 1 of 2 connected");
	// A person with only a teammate's machine has it counted too; nothing is known before an answer.
	expect(summarizeLive({ machines: [], teammates: [shared], error: "" }))
		.toEqual({ total: 1, connected: 1 });
	expect(summarizeLive({ error: "" })).toBeUndefined();
	expect(summarizeLive({ machines: own, error: "" })).toEqual({ total: 1, connected: 1 });
});

test("the machines list is one list, newest first as the person's own are stored, a teammate's shared machine among them", () => {
	let own = [
		{ id: "own-new", createdAt: 3_000 },
		{ id: "own-old", createdAt: 500 },
	] as never;
	// A shared machine newer than one of the person's own is above it, older is below.
	let teammates = [
		{ ...shared, id: "shared-newest", createdAt: 4_000 },
		{ ...shared, id: "shared-middle", createdAt: 1_000 },
	];
	expect(allMachines({ machines: own, teammates })?.map(value => value.id))
		.toEqual(["shared-newest", "own-new", "shared-middle", "own-old"]);
	// Whatever order the lists arrive in.
	expect(
		allMachines({ machines: [...own].toReversed(), teammates: [...teammates].toReversed() })?.map(
			value => value.id,
		),
	).toEqual(["shared-newest", "own-new", "shared-middle", "own-old"]);
	// Machines paired at the same moment keep the order storage gives them: by id.
	let tied = [{ id: "b", createdAt: 7 }, { id: "a", createdAt: 7 }] as never;
	expect(
		allMachines({ machines: tied, teammates: [{ ...shared, id: "c", createdAt: 7 }] })?.map(
			value => value.id,
		),
	).toEqual(["a", "b", "c"]);
	expect(allMachines({})).toBeUndefined();
});

test("a teammate's owner is named only where another machine has the same name", () => {
	let desk = { label: "Desk", owner: { login: "rival" } };
	let all = [{ label: "desk" }, desk, { label: "rack" }];
	expect(ownerHint(desk, all)).toBe("rival");
	expect(ownerHint({ label: "rack", owner: { login: "rival" } }, all)).toBeUndefined();
	// The person's own machine never names an owner, whatever it shares a name with.
	expect(ownerHint({ label: "desk" }, all)).toBeUndefined();
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
	let third = Promise.withResolvers<void>();
	let feed = machineFeed(async () => {
		if (++answers === 3) third.resolve();
		return [machineOf("box", online)];
	}, { interval: 20 });
	let heard: boolean[] = [];
	let initial = Promise.withResolvers<void>();
	let unwatch = feed.watch(() => {
		heard.push(feed.snapshot().machines![0]!.connected);
		if (heard.length === 1) initial.resolve();
	});
	let stop = feed.poll();
	let stopped = false;
	try {
		await initial.promise;
		expect(answers).toBe(1);
		online = false;
		await third.promise;
		stop();
		stopped = true;
		let after = answers;
		await Bun.sleep(60);
		expect(answers).toBe(after);
		// Each answer was heard once it said something new: the machine going offline, not the
		// answers that repeated it.
		expect(heard).toEqual([true, false]);
	} finally {
		unwatch();
		if (!stopped) stop();
	}
});

test("two pollers share one list, which keeps polling until both stop", async () => {
	let answers = 0;
	let refreshed = Promise.withResolvers<void>();
	let feed = machineFeed(async () => {
		// Two pollers started two asks at once; the third is the list asked again after the interval.
		if (++answers === 3) refreshed.resolve();
		return [];
	}, { interval: 20 });
	let initial = Promise.withResolvers<void>();
	let unwatch = feed.watch(() => initial.resolve());
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
	expect(feed.snapshot()).toEqual({
		machines: [machineOf("box", true)],
		teammates: [],
		error: "unavailable",
	});
	visible = false;
	await feed.load();
	expect(answers).toBe(2);
	feed.update(list => list.filter(machine => machine.id !== "box"));
	expect(feed.snapshot().machines).toEqual([]);
});

test("an answer that changes nothing is not published again; a change, a failure and a recovery are", async () => {
	let online = true;
	let fail = "";
	let feed = machineFeed(async () => {
		if (fail) throw new Error(fail);
		return [machineOf("box", online), shared];
	});
	let heard = 0;
	feed.watch(() => heard++);
	// The first answer is news even if it is an empty list.
	await feed.load();
	expect(heard).toBe(1);
	let held = feed.snapshot();
	// Answers that say what the page already holds publish nothing, and keep the very same list, so
	// nothing that renders it renders again.
	await feed.load();
	await feed.load();
	expect(heard).toBe(1);
	expect(feed.snapshot()).toBe(held);
	online = false;
	await feed.load();
	expect(heard).toBe(2);
	expect(feed.snapshot().machines![0]!.connected).toBe(false);
	// A failure is told once; the same failure again is not news, a different one is.
	fail = "unavailable";
	await feed.load();
	await feed.load();
	expect(heard).toBe(3);
	fail = "offline";
	await feed.load();
	expect(heard).toBe(4);
	// A good answer after a failure clears the error, though the list is the one it held.
	fail = "";
	await feed.load();
	expect(heard).toBe(5);
	expect(feed.snapshot().error).toBe("");
	// What the page changes itself is always published, before the server says.
	feed.favor("box");
	expect(heard).toBe(6);
	feed.update(list => list.filter(value => value.id !== "box"));
	expect(heard).toBe(7);
});

test("the feed keeps teammates' shared machines apart from the person's own", async () => {
	let feed = machineFeed(async () => [machineOf("mine", true), shared]);
	await feed.load();
	expect(feed.snapshot().machines?.map(machine => machine.id)).toEqual(["mine"]);
	expect(feed.snapshot().teammates).toEqual([shared]);
	// The person's own list alone is what a removal changes.
	feed.update(list => list.filter(machine => machine.id !== "mine"));
	expect(feed.snapshot().machines).toEqual([]);
	expect(feed.snapshot().teammates).toEqual([shared]);
});

test("a favorite marks one machine, the person's own or a teammate's, and none after it is cleared", async () => {
	let feed = machineFeed(async () => [
		{ ...machineOf("mine", true), favorite: true } as never,
		shared,
	]);
	await feed.load();
	let favorites = () => [
		...feed.snapshot().machines!.map(value => [value.id, value.favorite]),
		...feed.snapshot().teammates!.map(value => [value.id, value.favorite]),
	];
	expect(favorites()).toEqual([["mine", true], ["theirs", false]]);
	feed.favor("theirs");
	expect(favorites()).toEqual([["mine", false], ["theirs", true]]);
	feed.favor(null);
	expect(favorites()).toEqual([["mine", false], ["theirs", false]]);
});
