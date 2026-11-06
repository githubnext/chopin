import { expect, test } from "bun:test";
import { CONNECTION_GRACE } from "@chopin/editor";

import { plannerGrace, plannerShownAtOnce } from "./planner-settle";
import { plannerStatus } from "./planner-status";

import type { Session } from "@chopin/protocol";
import type { PlannerStatus } from "./planner-status";

const AT = "2026-11-04T18:29:00.000Z";

function status(planner: Session.PlannerAttachment): PlannerStatus {
	return plannerStatus(planner)!;
}

const STARTING = status({ state: "starting", login: "mona" });
const NONE = status({ state: "none" });
const OFFLINE = status({ state: "disconnected", login: "mona" });
const AWAY = status({ state: "held", login: "mona", until: AT });
const FAILING = status({
	state: "starting",
	login: "mona",
	failure: { attempts: 2, reason: "exit 1", at: AT },
});

test("only a machine being connected to, or none yet, waits out the grace period before it is said", () => {
	expect(plannerGrace(STARTING)).toBe(CONNECTION_GRACE);
	expect(plannerGrace(NONE)).toBe(CONNECTION_GRACE);
	for (let said of [undefined, OFFLINE, AWAY, FAILING]) expect(plannerGrace(said)).toBe(0);
});

test("a state replaces the one shown at once unless it is one that waits, and what clears goes at once", () => {
	// Nothing was shown: a machine being connected to, or none yet, says nothing for a moment.
	expect(plannerShownAtOnce(undefined, STARTING)).toBe(false);
	expect(plannerShownAtOnce(undefined, NONE)).toBe(false);
	// The last state stays through the moment, as it does through a restart.
	expect(plannerShownAtOnce(OFFLINE, STARTING)).toBe(false);
	expect(plannerShownAtOnce(NONE, STARTING)).toBe(false);
	// The same state with more in it, such as the machine's name, is said as it comes.
	expect(plannerShownAtOnce(STARTING, status({ state: "starting", login: "casey" }))).toBe(true);
	// What a person can act on, and every state clearing, is said at once.
	for (let shown of [undefined, STARTING, NONE, OFFLINE]) {
		expect(plannerShownAtOnce(shown, FAILING)).toBe(true);
		expect(plannerShownAtOnce(shown, OFFLINE)).toBe(true);
		expect(plannerShownAtOnce(shown, undefined)).toBe(true);
	}
});
