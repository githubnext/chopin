import { expect, test } from "bun:test";

import { wakePlanner } from "./wake";

import type { Session } from "@chopin/protocol";

function deps(planner: Session.PlannerAttachment, machine: boolean, machines = true) {
	let asked: Array<[string, boolean | undefined]> = [];
	return {
		asked,
		deps: {
			attachments: { status: () => planner },
			experiments: {
				plannerMachines: machines,
				plannerUsed: async (id: string, ask?: boolean) => {
					asked.push([id, ask]);
				},
				plannerStarting: async () => machine ? { login: "ana", machineId: "m" } : undefined,
			},
		},
	};
}

test("a document with no Planner and a machine that can run it asks that machine, once", async () => {
	let { deps: wired, asked } = deps({ state: "none" }, true);
	expect(await wakePlanner("doc", wired)).toEqual({ asked: true });
	expect(asked).toEqual([["doc", true]]);
});

test("a document with no Planner and no machine to run it asks nobody and says so", async () => {
	let { deps: wired } = deps({ state: "none" }, false);
	expect(await wakePlanner("doc", wired)).toEqual({ asked: false, why: "no-machine" });
});

test("a Planner that is attached, whose connection dropped, or that another account holds is left as it is", async () => {
	for (
		let planner of [
			{ state: "attached", login: "ana" },
			{ state: "disconnected", login: "ana" },
			{ state: "held", login: "bob", until: "2026-01-01T00:00:00.000Z" },
		] as const
	) {
		let { deps: wired, asked } = deps(planner, true);
		expect(await wakePlanner("doc", wired)).toEqual({ asked: false, why: planner.state });
		expect(asked).toEqual([]);
	}
});

test("a server that does not run Planners on machines says so and asks nobody", async () => {
	let { deps: wired, asked } = deps({ state: "none" }, true, false);
	expect(await wakePlanner("doc", wired)).toEqual({ asked: false, why: "unavailable" });
	expect(await wakePlanner("doc", { ...wired, attachments: undefined }))
		.toEqual({ asked: false, why: "unavailable" });
	expect(asked).toEqual([]);
});
