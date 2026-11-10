import type { Session } from "@chopin/protocol";
import type { ConnectionView } from "./connection-phase";

/** Where a machine that cannot be connected to is explained, and what to do about it. */
export const PLANNER_HOW_TO_FIX =
	"https://github.com/githubnext/chopin/blob/main/docs/chopin-cli.md#cant-connect-to-a-machine";

/**
 * What the document says about its remote Planner when it is not simply attached and healthy,
 * which says nothing at all. The connection banner and the machine button use the same words
 * (see `connection-phase.ts`).
 *
 * Plain words, with none of Chopin's own terms (no Planner, attach, hold or Decisions, and no
 * mention of Chopin) and a machine, not a Planner, as the subject: `starting` is connecting to it,
 * `cant-start` is not being able to, with why as the machine reported it and what has been tried,
 * and a `starting` one says which launch it waits on (`attempt`) once an earlier one exited;
 * `disconnected` and `held` say the work is kept; `none` says a machine is needed. Only the GitHub
 * login is ever named, never someone else's machine, so another person's machine is "@mona's
 * machine"; the viewer's own machine is named plainly. `status-copy.test.tsx` keeps it so.
 */
export type PlannerStatus =
	| { kind: "starting"; text: string; attempt?: number }
	| { kind: "cant-start"; title: string; reason: string; detail: string; attempts: number }
	| { kind: "disconnected"; text: string }
	| { kind: "held"; text: string }
	| { kind: "none"; text: string };

/** A time of day in the viewer's own clock, as the rest of Chat writes it. */
export function clockTime(iso: string): string {
	return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** When a machine was last seen: the time of day today, with its date on any other day. */
function seenAt(iso: string): string {
	let at = new Date(iso);
	return at.toDateString() === new Date().toDateString()
		? clockTime(iso)
		: at.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export const NO_MACHINE = "No machine is connected.";

/**
 * Whether the status of `planner` is only withheld: it is starting or has dropped, and `machine`
 * is `null`, so which machine is not known yet and nothing is said until it is.
 */
export function plannerWithheld(
	planner: Session.PlannerAttachment | undefined,
	machine: string | null | undefined,
): boolean {
	return machine === null && (planner?.state === "starting" || planner?.state === "disconnected");
}

/**
 * `machine` names the document's own machine where the Planner is on it; without one the status
 * says whose machine it is by login. `null` says the machine a starting or disconnected Planner
 * is on is not known yet, and nothing is said until it is.
 */
export function plannerStatus(
	planner: Session.PlannerAttachment | undefined,
	machine?: string | null,
	lastSeen?: string,
): PlannerStatus | undefined {
	if (!planner || planner.state === "attached") return undefined;
	if (planner.state === "none") return { kind: "none", text: NO_MACHINE };
	if (plannerWithheld(planner, machine)) return undefined;
	let where = machine ?? `@${planner.login}'s machine`;
	if (planner.state === "held") {
		return {
			kind: "held",
			text: `${where} stepped away. Your work is kept until ${clockTime(planner.until)}.`,
		};
	}
	if (planner.state === "disconnected") {
		return {
			kind: "disconnected",
			text: `${where} is offline. ${
				lastSeen ? `Last seen ${seenAt(lastSeen)}.` : "Your work is kept."
			}`,
		};
	}
	let failure = planner.failure;
	if (!failure) {
		return {
			kind: "starting",
			text: `Connecting to ${where}`,
			...(planner.attempt === undefined ? {} : { attempt: planner.attempt }),
		};
	}
	return {
		kind: "cant-start",
		attempts: failure.attempts,
		title: `Can't connect to ${where}`,
		// Exactly as the machine reported it: a path, a command or a code is not ours to tidy.
		reason: failure.reason,
		detail: `${
			failure.attempts === 1 ? "Tried once" : `Tried ${failure.attempts} times`
		}, last at ${clockTime(failure.at)}. Still trying.`,
	};
}

/** The status as one sentence a name, a tooltip, a strip or a screen reader can carry. */
export function plannerSentence(status: PlannerStatus): string {
	return status.kind === "cant-start" ? `${status.title}.` : status.text;
}

/**
 * What the machine button's status dot becomes: a spinner while the Planner starts, a warning
 * where it cannot, and a muted grey while it is away. With no machine connected there is no dot
 * at all, the bare icon of a button that has no machine; the machine's own green is never lent to
 * it. Only a healthy Planner leaves the machine's own dot as it is.
 */
export type PlannerGlyph = "starting" | "failing" | "away" | "none";

export function plannerGlyph(status: PlannerStatus | undefined): PlannerGlyph | undefined {
	if (!status) return undefined;
	return status.kind === "starting"
		? "starting"
		: status.kind === "cant-start"
		? "failing"
		: status.kind === "none"
		? "none"
		: "away";
}

/** The machine button's accessible name and tooltip, with what is happening to its Planner. */
export function plannerButtonLabel(label: string, status: PlannerStatus | undefined): string {
	return status ? `${label}. ${plannerSentence(status)}` : label;
}

/** Null quiets the button's status, including its machine dot, without inventing a Planner state. */
export type PlannerPlacement = { button: PlannerStatus | null | undefined };

/** The button yields only to the same Planner status actually shown by Chat's banner. */
export function plannerPlacement(
	status: PlannerStatus | undefined,
	hasButton: boolean,
	view?: ConnectionView,
	chatVisible = false,
): PlannerPlacement {
	if (!hasButton) return { button: undefined };
	if (
		status && chatVisible && view && (view.phase === "dropped" || view.phase === "reconnecting")
		&& view.layer === "planner" && view.text === plannerSentence(status)
	) return { button: null };
	return { button: status };
}
