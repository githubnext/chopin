import type { Session } from "@chopin/protocol";

/** Where a machine that cannot be connected to is explained, and what to do about it. */
export const PLANNER_HOW_TO_FIX =
	"https://github.com/githubnext/chopin/blob/main/docs/chopin-cli.md#cant-connect-to-a-machine";

/**
 * What the document says about its remote Planner when it is not simply attached and healthy,
 * which says nothing at all. The machine button, its menu, chopin's presence and the page's live
 * region use the same words (see `connection-phase.ts`), and the fix-it steps start from them
 * (`machine-fix.ts`).
 *
 * Plain words, with none of Chopin's own terms (no Planner, attach, hold or Decisions, and no
 * mention of Chopin) and a machine, not a Planner, as the subject: `starting` is connecting to it,
 * `cant-start` is not being able to, with why as the machine reported it (or, from one that cannot
 * say, what Chopin saw of it) and when it was last tried, never how often (`attempt` and
 * `attempts` are for the rules, not the words);
 * `disconnected` and `held` say the work is kept; `none` says a machine is needed. Only the GitHub
 * login is ever named, never someone else's machine, so another person's machine is "@mona's
 * machine"; the viewer's own machine is named plainly (`where`). `status-copy.test.tsx` keeps it so.
 */
export type PlannerStatus =
	| { kind: "starting"; text: string }
	| {
		kind: "cant-start";
		title: string;
		reason: string;
		detail: string;
		attempts: number;
		/** The machine, as the words name it, and its owner's login. */
		where: string;
		login: string;
	}
	| { kind: "disconnected"; text: string; where: string; login: string; seen?: string }
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
		let seen = lastSeen ? seenAt(lastSeen) : undefined;
		return {
			kind: "disconnected",
			text: `${where} is offline. ${seen ? `Last seen ${seen}.` : "Your work is kept."}`,
			where,
			login: planner.login,
			...(seen ? { seen } : {}),
		};
	}
	let failure = planner.failure;
	if (!failure) {
		return {
			kind: "starting",
			text: `Connecting to ${where}`,
		};
	}
	return {
		kind: "cant-start",
		attempts: failure.attempts,
		where,
		login: planner.login,
		title: `Can't connect to ${where}`,
		// Exactly as the machine reported it: a path, a command or a code is not ours to tidy.
		reason: failure.reason,
		// When, never how often: a person sees only that it connects or that it can't.
		detail: failure.attempts === 0
			// Nothing has been tried and ended yet: the machine has only not answered.
			? `Waiting since ${clockTime(failure.at)}.`
			: `Last tried at ${clockTime(failure.at)}.`,
	};
}

/** The status as one sentence a name, a tooltip, a strip or a screen reader can carry. */
export function plannerSentence(status: PlannerStatus): string {
	return status.kind === "cant-start" ? `${status.title}.` : status.text;
}

/**
 * What the machine button's status dot becomes: three dots while the Planner starts, a warning
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

/**
 * chopin's presence where Slack shows an app's, on its row of the `@` menu and on the chip: active
 * while its machine is attached, connecting while it starts, a warning where it can't, and away
 * otherwise. Nothing where the document has no remote Planner, or while its status is withheld.
 */
export type PlannerPresence = "active" | "connecting" | "failing" | "away";

export function plannerPresence(
	attachment: Session.PlannerAttachment | undefined,
	status: PlannerStatus | undefined,
): PlannerPresence | undefined {
	if (attachment?.state === "attached") return "active";
	if (!status) return undefined;
	return status.kind === "starting"
		? "connecting"
		: status.kind === "cant-start"
		? "failing"
		: "away";
}

/** The presence in words, as a screen reader hears it beside chopin's name. */
export const PRESENCE_WORDS: Record<PlannerPresence, string> = {
	active: "Active",
	connecting: "Connecting",
	failing: "Can't connect",
	away: "Away",
};
