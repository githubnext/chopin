import { expect, test } from "bun:test";
import { CONNECTION_GRACE } from "@chopin/editor";

import {
	plannerConnectionLost,
	plannerDrawn,
	plannerGrace,
	plannerRemembered,
	plannerShownAtOnce,
	plannerWordHeard,
} from "./planner-settle";
import { plannerStatus } from "./planner-status";

import type { Session } from "@chopin/protocol";
import type { PlannerMemory } from "./planner-settle";
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

function named(planner: Session.PlannerAttachment, machine: string): PlannerStatus {
	return plannerStatus(planner, machine)!;
}

const STARTING_B = named({ state: "starting", login: "mona" }, "Box B");
const STARTING_C = named({ state: "starting", login: "mona" }, "Box C");
const OFFLINE_B = named({ state: "disconnected", login: "mona" }, "Box B");
const OFFLINE_C = named({ state: "disconnected", login: "mona" }, "Box C");

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

test("a status that is withheld draws nothing, whatever was shown", () => {
	for (let shown of [undefined, STARTING, NONE, OFFLINE, AWAY, FAILING]) {
		for (let gapped of [false, true]) {
			expect(plannerDrawn(shown, undefined, false, true, gapped)).toBeUndefined();
		}
	}
});

test("with no gap, the last state stays until a state that waits has lasted its grace, and more of the same state is drawn as it comes", () => {
	expect(plannerDrawn(OFFLINE, NONE)).toBe(OFFLINE);
	expect(plannerDrawn(OFFLINE, STARTING)).toBe(OFFLINE);
	expect(plannerDrawn(OFFLINE, FAILING)).toBe(FAILING);
	expect(plannerDrawn(STARTING, status({ state: "starting", login: "casey" }))).toEqual(
		status({ state: "starting", login: "casey" }),
	);
});

test("after a gap, what was shown before it is never drawn in place of a different state: a state that waits draws nothing until its grace has passed", () => {
	// disconnected to starting, as the document moves to another machine
	expect(plannerDrawn(OFFLINE_B, STARTING_C, false, false, true)).toBeUndefined();
	// away to none
	expect(plannerDrawn(AWAY, NONE, false, false, true)).toBeUndefined();
	// starting to starting on another machine: the same kind, but not the same state
	expect(plannerShownAtOnce(STARTING_B, STARTING_C, false, true)).toBe(false);
	expect(plannerDrawn(STARTING_B, STARTING_C, false, false, true)).toBeUndefined();
	// what a person can act on, and every state clearing, is drawn at once, as it always was
	expect(plannerDrawn(STARTING_B, OFFLINE_C, false, false, true)).toBe(OFFLINE_C);
	expect(plannerDrawn(OFFLINE_B, FAILING, false, false, true)).toBe(FAILING);
	expect(plannerDrawn(OFFLINE_B, undefined, false, false, true)).toBeUndefined();
	// a placeholder still waits for the machine's own word
	expect(plannerShownAtOnce(NONE, NONE, true, true)).toBe(false);
});

test("after a gap, only the same state returning skips its grace", () => {
	expect(
		plannerShownAtOnce(
			STARTING_B,
			named({ state: "starting", login: "mona" }, "Box B"),
			false,
			true,
		),
	)
		.toBe(true);
	expect(plannerShownAtOnce(NONE, NONE, false, true)).toBe(true);
	// There was nothing to remember: the grace is waited out as for any first state.
	expect(plannerShownAtOnce(undefined, STARTING_B, false, true)).toBe(false);
	expect(plannerShownAtOnce(OFFLINE_B, STARTING_B, false, true)).toBe(false);
});

/**
 * The hook's wiring in miniature: each render draws from what is remembered, then the effects
 * remember, and a grace that waits may lapse. What is drawn must not differ between the two.
 */
function settling(first?: PlannerStatus) {
	let memory: PlannerMemory = {
		shown: first && plannerGrace(first) === 0 ? first : undefined,
		gapped: false,
	};
	let draw = (status: PlannerStatus | undefined, held: boolean, withheld: boolean) =>
		plannerDrawn(memory.shown, status, held, withheld, memory.gapped);
	return {
		render(status: PlannerStatus | undefined, { held = false, withheld = false } = {}) {
			let before = draw(status, held, withheld);
			memory = plannerRemembered(memory, status, held, withheld);
			expect(draw(status, held, withheld)).toBe(before);
			return before;
		},
		lapse(status: PlannerStatus | undefined) {
			memory = plannerRemembered(memory, status, false, false, true);
			return draw(status, false, false);
		},
	};
}

test("a state of another kind arriving after the gap is drawn by its own rules, never the one shown before the gap", () => {
	// disconnected to starting: the old state is not redrawn, and the new one shows once it has lasted
	let moved = settling();
	expect(moved.render(OFFLINE_B)).toBe(OFFLINE_B);
	expect(moved.render(undefined, { withheld: true })).toBeUndefined();
	expect(moved.render(undefined, { withheld: true })).toBeUndefined();
	expect(moved.render(STARTING_C)).toBeUndefined();
	expect(moved.render(STARTING_C)).toBeUndefined();
	expect(moved.lapse(STARTING_C)).toBe(STARTING_C);
	expect(moved.render(STARTING_C)).toBe(STARTING_C);

	// away to none
	let removed = settling();
	expect(removed.render(AWAY)).toBe(AWAY);
	expect(removed.render(undefined, { withheld: true })).toBeUndefined();
	expect(removed.render(NONE)).toBeUndefined();
	expect(removed.lapse(NONE)).toBe(NONE);

	// starting to disconnected: what a person can act on is drawn at once
	let dropped = settling();
	expect(dropped.render(STARTING_B)).toBeUndefined();
	expect(dropped.lapse(STARTING_B)).toBe(STARTING_B);
	expect(dropped.render(undefined, { withheld: true })).toBeUndefined();
	expect(dropped.render(OFFLINE_C)).toBe(OFFLINE_C);
	expect(dropped.render(OFFLINE_C)).toBe(OFFLINE_C);

	// starting to starting on another machine
	let rehomed = settling();
	rehomed.render(STARTING_B);
	rehomed.lapse(STARTING_B);
	expect(rehomed.render(undefined, { withheld: true })).toBeUndefined();
	expect(rehomed.render(STARTING_C)).toBeUndefined();
	expect(rehomed.lapse(STARTING_C)).toBe(STARTING_C);
});

test("the same state returning after the gap is drawn at once, however long the gap, and does not wait out its grace again", () => {
	let again = settling();
	again.render(STARTING_B);
	again.lapse(STARTING_B);
	expect(again.render(undefined, { withheld: true })).toBeUndefined();
	expect(again.render(undefined, { withheld: true })).toBeUndefined();
	expect(again.render(STARTING_B)).toBe(STARTING_B);
	// It is shown now, as if there had been no gap: what comes next is judged against it.
	expect(again.render(OFFLINE_B)).toBe(OFFLINE_B);
	expect(again.render(NONE)).toBe(OFFLINE_B);
	expect(again.lapse(NONE)).toBe(NONE);
});

test("what was remembered through a gap does not outlive the next state drawn", () => {
	let later = settling();
	later.render(STARTING_B);
	later.lapse(STARTING_B);
	later.render(undefined, { withheld: true });
	expect(later.render(OFFLINE_B)).toBe(OFFLINE_B);
	// Gone: a second gap starts from what is shown now, and the first state is no longer returning.
	later.render(undefined, { withheld: true });
	expect(later.render(STARTING_B)).toBeUndefined();
	expect(later.lapse(STARTING_B)).toBe(STARTING_B);
});

test("with no gap, a reconnect's placeholder and the grace of a state that waits leave the last state as they always did", () => {
	let restart = settling();
	expect(restart.render(OFFLINE)).toBe(OFFLINE);
	expect(restart.render(NONE, { held: true })).toBe(OFFLINE);
	expect(restart.render(NONE, { held: true })).toBe(OFFLINE);
	expect(restart.render(NONE)).toBe(OFFLINE);
	expect(restart.lapse(NONE)).toBe(NONE);
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
