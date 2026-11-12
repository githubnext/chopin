import type { MachineChoiceState } from "../machine-choice";
import type { PlannerStatus } from "./planner-status";

/**
 * A person moving the document's Planner to another machine, told as one transition: _Connecting
 * to Box B_ from the moment they choose it until the server's word after the choice is known, which
 * then says the rest (nothing once it attaches, the can't-start state where it can't).
 *
 * Without it the page said nothing between the two machines: the old state went with the click, the
 * list that names the new machine was read again after the server's word, and the status was
 * withheld while it was, so connecting came, went and came again. `began` is where the choice began
 * in the order of `nextReading`, so a word heard after it is the server's answer to it.
 */
export type MachineSwitch = { to: string; machine: string; began: number };

/**
 * The switch a choice of `machine` starts, or none: only a named machine other than the one shown,
 * and only where the person's choice places the Planner (not where the creator's decides).
 */
export function switchFor(
	state: MachineChoiceState | undefined,
	machine: string | null,
	began: number,
	shown: string | undefined,
): MachineSwitch | undefined {
	if (!state || machine === null || state.creatorDecides || machine === shown) return undefined;
	let to = state.machines.find(value => value.id === machine)?.label;
	return to ? { to, machine, began } : undefined;
}

/**
 * Whether a switch carries on once its choice is saved: the server's answer says the Planner is now
 * starting on the machine chosen. Any other answer (it attached there already, or the choice does
 * not move it) ends it, and the status says what the server says.
 */
export function switchSaved(change: MachineSwitch, saved: MachineChoiceState): boolean {
	return saved.planner?.state === "starting" && saved.planner.machine === change.machine;
}

/**
 * What the status says during a switch, and whether the switch is over. While the choice is saved,
 * and until a word heard after it is known by its machine (`withheld` false), it is connecting to
 * the machine chosen; then the server's own status takes over, whatever it is.
 */
export function switchedStatus(
	change: MachineSwitch | undefined,
	{ status, saving, heard, withheld }: {
		status: PlannerStatus | undefined;
		saving: boolean;
		/** Where the latest word arrived in the order of `nextReading`. */
		heard: number | undefined;
		withheld: boolean;
	},
): { status: PlannerStatus | undefined; over: boolean } {
	if (!change) return { status, over: false };
	if (!saving && heard !== undefined && heard > change.began && !withheld) {
		return { status, over: true };
	}
	return { status: { kind: "starting", text: `Connecting to ${change.to}` }, over: false };
}
