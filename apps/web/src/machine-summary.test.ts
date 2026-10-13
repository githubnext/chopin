import { expect, test } from "bun:test";
import { machinesLabel, summarizeMachines, updateAvailable } from "./machine-summary";

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
