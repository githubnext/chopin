import { expect, test } from "bun:test";
import { CONNECTION_GRACE } from "@chopin/editor";

import {
	plannerConnectionLost,
	plannerGrace,
	plannerShownAtOnce,
	plannerWordHeard,
} from "./planner-settle";
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

test("a placeholder changes nothing shown: not at once, and not for whichever state is shown", () => {
	for (let shown of [undefined, STARTING, NONE, OFFLINE, AWAY, FAILING]) {
		expect(plannerShownAtOnce(shown, NONE, true)).toBe(false);
	}
	expect(plannerShownAtOnce(NONE, NONE, true)).toBe(false);
	// Told as a live word, the same none settles as it always did.
	expect(plannerShownAtOnce(NONE, NONE, false)).toBe(true);
	expect(plannerShownAtOnce(undefined, NONE, false)).toBe(false);
});

const HERE: Session.PlannerAttachment = { state: "attached", login: "mona" };
const NO_MACHINE: Session.PlannerAttachment = { state: "none" };

test("after a loss, the none a new server tells first is its placeholder, but only for a page that knew a state, and only until another state comes", () => {
	// A page whose first word is none knows nothing yet: the word is its own, and a loss changes nothing.
	let fresh = plannerWordHeard("unknown", NO_MACHINE);
	expect(fresh).toBe("unknown");
	expect(plannerWordHeard(plannerConnectionLost(fresh), NO_MACHINE)).toBe("unknown");

	// A page that knew a state keeps it through every none the new server tells, however many.
	let known = plannerWordHeard("unknown", HERE);
	expect(known).toBe("known");
	let returning = plannerConnectionLost(known);
	expect(returning).toBe("returning");
	for (let word of [NO_MACHINE, NO_MACHINE, NO_MACHINE]) {
		returning = plannerWordHeard(returning, word);
		expect(returning).toBe("returning");
	}
	// Another loss before the machine is back changes nothing.
	expect(plannerConnectionLost(returning)).toBe("returning");

	// Any other state is a fresh word, and ends it: a none after that is the machine's removal.
	let back = plannerWordHeard(returning, { state: "starting", login: "mona" });
	expect(back).toBe("known");
	expect(plannerWordHeard(back, NO_MACHINE)).toBe("unknown");
	// A none while connected, with no loss, was never a placeholder.
	expect(plannerWordHeard("known", NO_MACHINE)).toBe("unknown");
	// A page that knew none keeps knowing none, and a loss then still says nothing new.
	expect(plannerConnectionLost(plannerWordHeard("known", NO_MACHINE))).toBe("unknown");
});
