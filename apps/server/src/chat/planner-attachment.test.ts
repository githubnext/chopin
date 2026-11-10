import { expect, test } from "bun:test";

import { plannerAttachment } from "./planner-attachment";

test("a Planner nobody holds is told as starting with the launch its machine waits on, once one has exited", () => {
	let none = { state: "none" } as const;
	expect(plannerAttachment(none, undefined)).toEqual(none);
	expect(plannerAttachment(none, { login: "mona" })).toEqual({ state: "starting", login: "mona" });
	// No count is told where none is known: never a first launch made up for a machine just asked.
	expect("attempt" in plannerAttachment(none, { login: "mona" })).toBe(false);
	expect(plannerAttachment(none, { login: "mona", attempt: 2 })).toEqual({
		state: "starting",
		login: "mona",
		attempt: 2,
	});
	let failure = { attempts: 2, reason: "no git", at: "2026-11-10T00:00:00.000Z" };
	expect(plannerAttachment(none, { login: "mona", attempt: 3, failure })).toEqual({
		state: "starting",
		login: "mona",
		attempt: 3,
		failure,
	});
});

test("a Planner somebody holds is told as it is held, whatever a machine was asked", () => {
	let held = { state: "held", login: "mona", until: "2026-11-10T00:00:00.000Z" } as const;
	expect(plannerAttachment(held, { login: "mona", attempt: 2 })).toEqual(held);
	let away = { state: "disconnected", login: "mona" } as const;
	expect(plannerAttachment(away, { login: "mona", attempt: 2 })).toEqual(away);
});
